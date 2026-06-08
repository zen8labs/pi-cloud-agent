"""Agent bridge: drive OpenCode and forward its events to the controller.

Our controller is a FastAPI service we reach over plain HTTP. A run is
*outbound-driven* and single-shot, and — crucially — it is **request/response**,
not event-inference:

  * **Control flow** is one synchronous call. The bridge POSTs the task to
    OpenCode's ``/session/{id}/message`` endpoint, which runs the prompt loop
    *to completion — including every subagent it spawns* — and only then returns
    the final assistant message. The HTTP response IS the completion signal:
    it returning means "done", ``info.error`` means "failed", and the request's
    own read timeout means "took too long". There is no idle-detection heuristic.

  * **Telemetry** is a separate, best-effort concern. A background task
    subscribes to OpenCode's ``/event`` SSE stream and forwards live progress
    (tokens, tool calls, subagent activity) to the controller so the dashboard
    can show the agent working. This stream NEVER decides when the run is over,
    so a dropped/misordered/stalled event can make the UI momentarily imperfect
    but can never orphan a run.

This split is deliberate. The previous design used the fire-and-forget
``prompt_async`` endpoint and tried to *infer* completion from the event stream
(``session.idle`` / ``session.status`` / ``step_finish`` reason). That inference
broke whenever subagents were involved — the parent's terminal signal never
arrived the way we expected — and the run hung as ``Running`` forever because the
only backstop was a timeout coupled to the same broken stream.

Controller HTTP API (base = ``CONTROL_PLANE_URL``; every call carries
``Authorization: Bearer ${SANDBOX_AUTH_TOKEN}``):

    POST /internal/runs/{RUN_ID}/events   {"type": str, "data": obj}
    POST /internal/runs/{RUN_ID}/status   {"status": str, "detail": str|null}

The bridge relays telemetry only. The agent actuates its own outcomes (PR
comments, pushes) from inside the sandbox using the baked SCM token — there is
no findings callback and no controller-side publish step.

OpenCode 1.16.2 server API the bridge drives:

    POST /session                              -> {"id": ...}             (create)
    GET  /session/{id}                         -> 200 if it still exists  (validate)
    GET  /event                                -> SSE stream (telemetry only)
    POST /session/{id}/message                 -> {"info", "parts"}       (SYNC: blocks
                                                  until the whole run, incl. subagents,
                                                  completes; returns the final message)
    POST /session/{id}/abort                   stop the in-flight run

Subagent attribution in the telemetry stream is by ``sessionID``: every part
event carries the session it belongs to, and a subagent's ``session.created``
event carries its ``parentID`` (our parent session) and a human ``title`` — so
we label subagent activity reliably without reconstructing OpenCode internals.
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import os
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import httpx

from .constants import OPENCODE_PORT, OPENCODE_SESSION_ID_FILE
from .log_config import configure_logging, get_logger


class SSEConnectionError(Exception):
    """Raised when the OpenCode SSE telemetry connection fails."""


class AgentBridge:
    """Bridge between the sandbox's OpenCode instance and the controller.

    Responsibilities:
      * create/attach an OpenCode session;
      * run the task to completion via the synchronous ``/message`` call
        (control flow — its return is the authoritative terminal signal);
      * concurrently forward OpenCode's ``/event`` SSE stream to the controller
        as live progress (telemetry — best-effort, never load-bearing);
      * post a terminal ``{"status": "done"}`` / ``{"status": "error", ...}``.
    """

    # Tunables (seconds).
    SSE_INACTIVITY_TIMEOUT = 120.0
    SSE_INACTIVITY_TIMEOUT_MIN = 5.0
    SSE_INACTIVITY_TIMEOUT_MAX = 3600.0
    HTTP_CONNECT_TIMEOUT = 30.0
    HTTP_DEFAULT_TIMEOUT = 30.0
    OPENCODE_REQUEST_TIMEOUT = 30.0
    # Hard wall-clock ceiling for the synchronous prompt call. Enforced directly
    # as the read timeout on that one awaited request — reliable, in run_review's
    # own frame (no async-generator boundary to defeat it).
    PROMPT_MAX_DURATION = 5400.0
    # After the synchronous call returns, the SSE telemetry pump is usually still
    # flushing the tail of the stream (tool `completed` transitions, subagent
    # idle/done, the last text). The parent session does NOT emit a terminal
    # `session.idle` in 1.16.2, so we drain until the stream has been quiet for
    # TELEMETRY_DRAIN_QUIET seconds (capped at TELEMETRY_DRAIN_MAX) instead of
    # waiting for a specific event. Without this, late events are dropped and the
    # dashboard shows tools/subagents stuck "running" forever.
    TELEMETRY_DRAIN_QUIET = 2.0
    TELEMETRY_DRAIN_MAX = 60.0
    # Subagent transcript backfill is strictly best-effort. In some real E2B
    # runs, querying finished subagent sessions can stall long after the parent
    # run has already completed, so each fetch is aggressively time-bounded and
    # skipped on timeout rather than delaying terminal status forever.
    SUBAGENT_HISTORY_TIMEOUT = 5.0

    def __init__(
        self,
        run_id: str,
        session_id: str,
        control_plane_url: str,
        auth_token: str,
        opencode_port: int = OPENCODE_PORT,
    ) -> None:
        self.run_id = run_id
        self.session_id = session_id
        self.control_plane_url = control_plane_url.rstrip("/")
        self.auth_token = auth_token
        self.opencode_port = opencode_port
        self.opencode_base_url = f"http://localhost:{opencode_port}"

        self.log = get_logger(
            "bridge",
            service="coreview-runtime",
            run_id=run_id,
            session_id=session_id,
        )

        self.sse_inactivity_timeout = self._resolve_timeout_seconds(
            name="BRIDGE_SSE_INACTIVITY_TIMEOUT",
            default=self.SSE_INACTIVITY_TIMEOUT,
            min_value=self.SSE_INACTIVITY_TIMEOUT_MIN,
            max_value=self.SSE_INACTIVITY_TIMEOUT_MAX,
        )

        self.opencode_session_id: str | None = None
        self.session_id_file = Path(OPENCODE_SESSION_ID_FILE)

        # Two clients: a short-timeout one for controller POSTs + OpenCode
        # request/response calls, and a streaming client for the SSE telemetry
        # stream (opened with no read timeout inside the streaming context).
        self.http_client: httpx.AsyncClient | None = None
        self.opencode_client: httpx.AsyncClient | None = None

        # Inactivity watchdog state, shared between the telemetry pump (which
        # updates _last_activity) and the watchdog (which reads it). Monotonic
        # (event-loop clock), so only valid while the loop is running.
        self._last_activity: float = 0.0
        self._inactivity_tripped: bool = False
        self._inactivity_detail: str | None = None

        # Parent-session text streamed so far, keyed by part id. Lets the final
        # backfill (from the authoritative /message response) emit only the
        # suffix the SSE stream didn't already deliver, so the answer is never
        # duplicated. The dashboard appends token fragments, so we must always
        # send fragments — never cumulative text.
        self._parent_cumtext: dict[str, str] = {}

        # Telemetry state shared with run_review's terminal reconciliation. The
        # SSE stream's finalization events (subagent session.idle, tool
        # `completed`) often do not arrive before the sandbox is torn down, so
        # once the authoritative /message call returns we synthesize terminal
        # states from these. session_id → {description, cumulative_text, steps,
        # done}; callId → {sid, is_parent, status, tool, args}.
        self._subagents: dict[str, dict[str, Any]] = {}
        self._tool_state: dict[str, dict[str, Any]] = {}

    # ------------------------------------------------------------------
    # Controller transport
    # ------------------------------------------------------------------

    @property
    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.auth_token}"}

    async def post_event(self, event_type: str, data: dict[str, Any]) -> None:
        """Forward a single OpenCode-derived event to the controller.

        POST /internal/runs/{RUN_ID}/events  {"type", "data"}. Best-effort: a
        transient controller hiccup must not abort the run, so failures are
        logged and swallowed.
        """
        if not self.http_client:
            return
        try:
            await self.http_client.post(
                f"{self.control_plane_url}/internal/runs/{self.run_id}/events",
                headers=self._auth_headers,
                json={"type": event_type, "data": data},
                timeout=self.HTTP_DEFAULT_TIMEOUT,
            )
        except Exception as e:  # noqa: BLE001 - event forwarding is best-effort
            self.log.warn("bridge.post_event_error", event_type=event_type, exc=e)

    async def post_status(self, status: str, detail: str | None = None) -> None:
        """Send a run status to the controller.

        POST /internal/runs/{RUN_ID}/status  {"status", "detail"}. ``done`` ends
        the run on the controller side, so unlike events this is logged loud.
        """
        if not self.http_client:
            return
        try:
            await self.http_client.post(
                f"{self.control_plane_url}/internal/runs/{self.run_id}/status",
                headers=self._auth_headers,
                json={"status": status, "detail": detail},
                timeout=self.HTTP_DEFAULT_TIMEOUT,
            )
        except Exception as e:  # noqa: BLE001
            self.log.error("bridge.post_status_error", status=status, exc=e)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def run_review(self, prompt: str) -> bool:
        """Drive a full run: start telemetry, run the prompt to completion, post done.

        Returns True if the run completed successfully, False on error/timeout.
        Posts a terminal status to the controller either way.
        """
        self.log.info("bridge.run_start", sse_inactivity_timeout_s=self.sse_inactivity_timeout)
        self.http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(self.HTTP_DEFAULT_TIMEOUT, connect=self.HTTP_CONNECT_TIMEOUT)
        )
        self.opencode_client = httpx.AsyncClient(
            timeout=httpx.Timeout(self.HTTP_DEFAULT_TIMEOUT, connect=self.HTTP_CONNECT_TIMEOUT)
        )

        try:
            await self._load_session_id()
            if not self.opencode_session_id:
                await self._create_opencode_session()

            loop = asyncio.get_running_loop()
            self._last_activity = loop.time()
            self._inactivity_tripped = False
            self._inactivity_detail = None
            self._parent_cumtext = {}
            self._subagents = {}
            self._tool_state = {}

            # Telemetry pump (best-effort) + inactivity watchdog. We start the
            # SSE subscription and wait for it to connect BEFORE sending the
            # prompt so the dashboard doesn't miss early progress.
            sse_ready = asyncio.Event()
            telemetry = asyncio.create_task(self._pump_sse_telemetry(sse_ready))
            watchdog = asyncio.create_task(self._inactivity_watchdog())
            try:
                try:
                    await asyncio.wait_for(sse_ready.wait(), timeout=self.HTTP_CONNECT_TIMEOUT)
                except TimeoutError:
                    # Telemetry is best-effort; proceed without it rather than
                    # failing the run for a missing progress stream.
                    self.log.warn("bridge.sse_not_ready")

                result = await self._send_prompt_sync(prompt)
                # The prompt is done, but the SSE pump is usually still flushing
                # the tail of the stream — let it catch up before we tear it down,
                # or tools/subagents are left visually stuck "running".
                await self._drain_telemetry(telemetry)
            finally:
                watchdog.cancel()
                telemetry.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await watchdog
                with contextlib.suppress(asyncio.CancelledError):
                    await telemetry

            # Backfill the authoritative final assistant text before we
            # synthesize terminal states, so subagent chats are not left looking
            # truncated just because the tail of SSE arrived after teardown.
            for ev in self._final_text_events(result):
                await self.post_event(ev["type"], ev["data"])
            for ev in await self._final_subagent_text_events():
                await self.post_event(ev["type"], ev["data"])

            # The run is authoritatively complete (the /message call returned).
            # Synthesize any terminal states the SSE stream didn't deliver before
            # teardown, so no tool/subagent is left visually "running".
            await self._reconcile_terminal_state()

            if self._inactivity_tripped:
                detail = self._inactivity_detail or "agent inactivity timeout"
                self.log.error("bridge.review_error", error=detail)
                await self.post_status("error", detail=detail)
                return False

            error_message = self._extract_error_message(result.get("info", {}).get("error"))
            if error_message:
                self.log.error("bridge.review_error", error=error_message)
                await self.post_status("error", detail=error_message)
                return False

            self.log.info("bridge.review_complete")
            await self.post_status("done")
            return True

        except httpx.TimeoutException as e:
            self.log.error("bridge.prompt_timeout", max_s=self.PROMPT_MAX_DURATION, exc=e)
            await self._request_opencode_stop("prompt_max_duration_timeout")
            await self.post_status(
                "error", detail=f"Prompt exceeded max duration of {self.PROMPT_MAX_DURATION:.0f}s."
            )
            return False
        except Exception as e:  # noqa: BLE001 - terminal boundary; report + return
            self.log.error("bridge.run_error", exc=e)
            await self.post_status("error", detail=str(e))
            return False
        finally:
            if self.http_client:
                await self.http_client.aclose()
            if self.opencode_client:
                await self.opencode_client.aclose()

    # ------------------------------------------------------------------
    # OpenCode session management
    # ------------------------------------------------------------------

    async def _create_opencode_session(self) -> None:
        """Create a fresh OpenCode session and persist its id."""
        assert self.opencode_client is not None
        resp = await self.opencode_client.post(
            f"{self.opencode_base_url}/session",
            json={},
            timeout=self.OPENCODE_REQUEST_TIMEOUT,
        )
        resp.raise_for_status()
        self.opencode_session_id = resp.json().get("id")
        self.log.info("opencode.session.created", opencode_session_id=self.opencode_session_id)
        await self._save_session_id()

    async def _load_session_id(self) -> None:
        """Re-attach to a persisted OpenCode session id if it's still valid."""
        if not self.session_id_file.exists():
            return
        try:
            sid = self.session_id_file.read_text().strip()
            if not sid:
                return
            assert self.opencode_client is not None
            resp = await self.opencode_client.get(
                f"{self.opencode_base_url}/session/{sid}",
                timeout=self.OPENCODE_REQUEST_TIMEOUT,
            )
            if resp.status_code == 200:
                self.opencode_session_id = sid
                self.log.info("opencode.session.loaded", opencode_session_id=sid)
        except Exception as e:  # noqa: BLE001
            self.log.warn("opencode.session.load_error", exc=e)

    async def _save_session_id(self) -> None:
        if not self.opencode_session_id:
            return
        try:
            self.session_id_file.write_text(self.opencode_session_id)
        except Exception as e:  # noqa: BLE001
            self.log.warn("opencode.session.save_error", exc=e)

    # ------------------------------------------------------------------
    # Control flow: the synchronous prompt call
    # ------------------------------------------------------------------

    async def _send_prompt_sync(self, content: str) -> dict[str, Any]:
        """Run the task to completion and return the final assistant message.

        ``POST /session/{id}/message`` blocks until OpenCode's prompt loop —
        including every subagent the task spawns — finishes, then returns
        ``{"info": AssistantMessage, "parts": [Part, ...]}``. ``messageID`` is
        left for the server to assign; the model is configured globally via
        ``OPENCODE_CONFIG_CONTENT`` so we don't override it per-prompt.

        The read timeout is the hard wall-clock ceiling for the whole run; on
        expiry httpx raises ``TimeoutException``, which run_review turns into a
        terminal error status. This is the *only* timeout that governs control
        flow, and it lives in run_review's own frame.
        """
        assert self.opencode_client is not None and self.opencode_session_id
        url = f"{self.opencode_base_url}/session/{self.opencode_session_id}/message"
        body = {"parts": [{"type": "text", "text": content}]}
        resp = await self.opencode_client.post(
            url,
            json=body,
            timeout=httpx.Timeout(self.PROMPT_MAX_DURATION, connect=self.HTTP_CONNECT_TIMEOUT),
        )
        if resp.status_code != 200:
            self.log.error(
                "bridge.prompt_request_error",
                status_code=resp.status_code,
                error_body=resp.text[:2000],
            )
            raise RuntimeError(f"Prompt failed: {resp.status_code} - {resp.text[:500]}")
        return resp.json()

    def _final_text_events(self, result: dict[str, Any]) -> list[dict[str, Any]]:
        """Turn the synchronous response's text parts into token events.

        The telemetry stream may have missed trailing tokens; the synchronous
        response is authoritative, so we emit its final text to guarantee the
        dashboard shows the complete answer.
        """
        events: list[dict[str, Any]] = []
        for part in result.get("parts", []):
            if part.get("type") != "text":
                continue
            full = part.get("text", "")
            if not full:
                continue
            part_id = part.get("id", "")
            prev = self._parent_cumtext.get(part_id, "")
            if len(full) <= len(prev):
                continue
            self._parent_cumtext[part_id] = full
            events.append({"type": "token", "data": {"content": full[len(prev):]}})
        return events

    async def _fetch_session_messages(self, session_id: str) -> list[dict[str, Any]]:
        """Read the current message history for a session, if OpenCode exposes it."""
        assert self.opencode_client is not None
        try:
            resp = await asyncio.wait_for(
                self.opencode_client.get(
                    f"{self.opencode_base_url}/session/{session_id}/message",
                    timeout=self.OPENCODE_REQUEST_TIMEOUT,
                ),
                timeout=self.SUBAGENT_HISTORY_TIMEOUT,
            )
        except TimeoutError:
            self.log.warn(
                "bridge.session_messages_fetch_timeout",
                session_id=session_id,
                timeout_s=self.SUBAGENT_HISTORY_TIMEOUT,
            )
            return []
        except Exception as e:  # noqa: BLE001 - best-effort backfill
            self.log.warn("bridge.session_messages_fetch_error", session_id=session_id, exc=e)
            return []
        if resp.status_code != 200:
            self.log.warn(
                "bridge.session_messages_fetch_error",
                session_id=session_id,
                status_code=resp.status_code,
            )
            return []
        payload = resp.json()
        return payload if isinstance(payload, list) else []

    async def _final_subagent_text_events(self) -> list[dict[str, Any]]:
        """Backfill any subagent assistant text that SSE failed to flush in time."""
        if not self.opencode_client:
            return []

        events: list[dict[str, Any]] = []
        for sid, sa in self._subagents.items():
            cumulative_text = sa.get("cumulative_text")
            if not isinstance(cumulative_text, dict):
                continue

            for msg in await self._fetch_session_messages(sid):
                info = msg.get("info", {})
                if info.get("role") != "assistant":
                    continue

                for part in msg.get("parts", []):
                    if part.get("type") != "text":
                        continue
                    full = part.get("text", "")
                    if not full:
                        continue

                    part_id = part.get("id", "")
                    prev = cumulative_text.get(part_id, "")
                    if len(full) <= len(prev):
                        continue

                    cumulative_text[part_id] = full
                    events.append(
                        {
                            "type": "subagent_event",
                            "data": {
                                "subagent_session_id": sid,
                                "task_description": sa.get("description", ""),
                                "event_type": "token",
                                "content": full[len(prev):],
                            },
                        }
                    )
        return events

    async def _drain_telemetry(self, telemetry: asyncio.Task) -> None:
        """Wait for the telemetry pump to flush the SSE tail after completion.

        The pump forwards each event with an awaited POST, so it lags behind a
        busy stream; when the synchronous prompt returns, the backlog (tool
        ``completed`` transitions, subagent ``session.idle``, trailing text) is
        still in flight. We let it keep draining until the stream has produced no
        meaningful event for ``TELEMETRY_DRAIN_QUIET`` seconds — bounded by
        ``TELEMETRY_DRAIN_MAX`` so a misbehaving stream can't stall shutdown.
        """
        loop = asyncio.get_running_loop()
        deadline = loop.time() + self.TELEMETRY_DRAIN_MAX
        while not telemetry.done() and loop.time() < deadline:
            quiet_for = loop.time() - self._last_activity
            if quiet_for >= self.TELEMETRY_DRAIN_QUIET:
                break
            await asyncio.sleep(min(self.TELEMETRY_DRAIN_QUIET - quiet_for, 0.5))

    async def _reconcile_terminal_state(self) -> None:
        """Synthesize terminal telemetry after the run is authoritatively done.

        The synchronous ``/message`` call returning proves the whole tree —
        parent and every subagent — finished. But OpenCode's session-level
        finalization events (subagent ``session.idle``, the parent ``task`` tool
        flipping to ``completed``) are emitted late and frequently don't reach
        the telemetry pump before the sandbox is torn down, leaving tools and
        subagents stuck "running" in the dashboard. So we emit the missing
        terminal states ourselves. This is idempotent: the UI keys tools by
        ``callId`` and subagents by session id, so re-emitting a terminal state
        just updates the existing entry.
        """
        for cid, ts in self._tool_state.items():
            if ts.get("status") in ("completed", "error"):
                continue
            data = {
                "tool": ts.get("tool", ""),
                "args": ts.get("args", {}),
                "callId": cid,
                "status": "completed",
                "output": "",
            }
            if ts.get("is_parent"):
                await self.post_event("tool_call", data)
            else:
                sid = ts.get("sid", "")
                await self.post_event(
                    "subagent_event",
                    {
                        "subagent_session_id": sid,
                        "task_description": self._subagents.get(sid, {}).get("description", ""),
                        "event_type": "tool_call",
                        **data,
                    },
                )
        for sid, sa in self._subagents.items():
            if sa.get("done"):
                continue
            sa["done"] = True
            self.log.info("bridge.subagent_done_reconciled", sid=sid)
            await self.post_event(
                "subagent_event",
                {
                    "subagent_session_id": sid,
                    "task_description": sa.get("description", ""),
                    "event_type": "done",
                },
            )

    # ------------------------------------------------------------------
    # Inactivity watchdog
    # ------------------------------------------------------------------

    async def _inactivity_watchdog(self) -> None:
        """Abort OpenCode if the telemetry stream goes silent for too long.

        This is a *fast-fail* convenience, not the primary guard (that is the
        synchronous prompt call's wall-clock read timeout). When no meaningful
        SSE activity has been seen for ``sse_inactivity_timeout`` seconds we
        ``/abort`` the session, which makes the in-flight ``/message`` call
        return so run_review can post a terminal status promptly instead of
        waiting out ``PROMPT_MAX_DURATION``.

        Unlike the previous threaded watchdog, this is an ordinary asyncio task:
        it reads a monotonic timestamp and aborts via the normal async client,
        so there is no cross-thread cancellation and no urllib fallback.
        """
        loop = asyncio.get_running_loop()
        poll = max(1.0, min(5.0, self.sse_inactivity_timeout / 2))
        while True:
            await asyncio.sleep(poll)
            idle = loop.time() - self._last_activity
            if idle >= self.sse_inactivity_timeout:
                self._inactivity_tripped = True
                self._inactivity_detail = (
                    f"No agent activity for {self.sse_inactivity_timeout:.0f}s "
                    "(no meaningful events)."
                )
                self.log.error(
                    "bridge.inactivity_timeout",
                    timeout_s=self.sse_inactivity_timeout,
                    idle_s=round(idle, 1),
                )
                await self._request_opencode_stop("inactivity_timeout")
                return

    # ------------------------------------------------------------------
    # Telemetry: SSE → controller events (best-effort, never load-bearing)
    # ------------------------------------------------------------------

    async def _parse_sse_stream(
        self,
        response: httpx.Response,
    ) -> AsyncIterator[dict[str, Any]]:
        """Parse the OpenCode Server-Sent-Events stream.

        SSE events are ``data: {json}`` blocks separated by blank lines.
        """
        buffer = ""
        async for chunk in response.aiter_text():
            buffer += chunk
            while "\n\n" in buffer:
                event_str, buffer = buffer.split("\n\n", 1)
                data_lines: list[str] = []
                for line in event_str.split("\n"):
                    if line.startswith("data:"):
                        data_content = line[5:].lstrip()
                        if data_content:
                            data_lines.append(data_content)
                if data_lines:
                    try:
                        yield json.loads("\n".join(data_lines))
                    except json.JSONDecodeError as e:
                        self.log.debug("bridge.sse_parse_error", exc=e)

    def _transform_part_to_event(self, part: dict[str, Any]) -> dict[str, Any] | None:
        """Map an OpenCode message part to a controller event envelope.

        Returns ``{"type": ..., "data": {...}}`` or ``None`` to drop the part.
        Token deltas are handled separately (see ``message.part.delta``); here we
        handle full text parts, tool parts, and step markers.
        """
        part_type = part.get("type", "")

        if part_type == "text":
            text = part.get("text", "")
            if text:
                return {"type": "token", "data": {"content": text}}

        elif part_type == "tool":
            state = part.get("state", {})
            status = state.get("status", "")
            tool_input = state.get("input", {})
            if status in ("pending", "") and not tool_input:
                return None
            return {
                "type": "tool_call",
                "data": {
                    "tool": part.get("tool", ""),
                    "args": tool_input,
                    "callId": part.get("callID", ""),
                    "status": status,
                    "output": state.get("output", ""),
                },
            }

        elif part_type == "step-start":
            return {"type": "log", "data": {"event": "step_start"}}

        elif part_type == "step-finish":
            return {
                "type": "log",
                "data": {
                    "event": "step_finish",
                    "cost": part.get("cost"),
                    "tokens": part.get("tokens"),
                    "reason": part.get("reason"),
                },
            }

        return None

    async def _pump_sse_telemetry(self, ready: asyncio.Event) -> None:
        """Forward OpenCode's live progress to the controller for the dashboard.

        Best-effort and **non-authoritative**: this never decides when the run is
        over (that is the synchronous ``/message`` call). Any failure here is
        logged and swallowed so a telemetry glitch can't affect the run.

        Routing is by ``sessionID``: events for the parent session are forwarded
        as ``token`` / ``tool_call`` / ``log``; events for a subagent session are
        wrapped as ``subagent_event``. Subagents are registered (with a human
        label) from their ``session.created`` event.
        """
        assert self.opencode_client is not None and self.opencode_session_id
        sse_url = f"{self.opencode_base_url}/event"
        loop = asyncio.get_running_loop()

        # session_id → {description, cumulative_text, steps, done}; shared with
        # run_review so terminal reconciliation can see registered subagents.
        subagents = self._subagents
        tool_state = self._tool_state
        parent_cumtext = self._parent_cumtext
        # partID → part type (text / reasoning / tool / step-*). Learned from
        # message.part.updated, which always precedes a part's first delta — so
        # we can keep reasoning out of the answer token stream.
        part_types: dict[str, str] = {}
        # messageID → role. Lets us forward only assistant parts (the user's own
        # prompt is a "user" message in the same session and must not be echoed
        # back as answer tokens). message.updated always precedes a message's parts.
        msg_roles: dict[str, str] = {}
        last_progress_log = loop.time()
        start = loop.time()

        def register_subagent(sid: str, description: str) -> None:
            if sid in subagents:
                return
            subagents[sid] = {"description": description, "cumulative_text": {}, "steps": 0}
            self.log.info("bridge.subagent_start", subagent_session_id=sid, description=description)

        async def emit_subagent(sid: str, ev: dict[str, Any]) -> None:
            sa = subagents[sid]
            if ev["type"] == "log" and ev["data"].get("event") == "step_finish":
                sa["steps"] += 1
                if sa["steps"] % 5 == 0:
                    self.log.warn(
                        "bridge.subagent_step_count",
                        sid=sid,
                        description=sa["description"],
                        step_count=sa["steps"],
                        last_reason=ev["data"].get("reason", "?"),
                        elapsed_s=round(loop.time() - start, 1),
                    )
            await self.post_event(
                "subagent_event",
                {
                    "subagent_session_id": sid,
                    "task_description": sa["description"],
                    "event_type": ev["type"],
                    **ev["data"],
                },
            )

        def append_delta(cumtext: dict[str, str], part_id: str, frag: str) -> None:
            cumtext[part_id] = cumtext.get(part_id, "") + frag

        def text_suffix(cumtext: dict[str, str], part_id: str, full: str) -> str:
            """New text beyond what we've already streamed for this part."""
            prev = cumtext.get(part_id, "")
            if len(full) <= len(prev):
                return ""
            cumtext[part_id] = full
            return full[len(prev):]

        # Decouple SSE reading from controller POSTing. Forwarding each event is a
        # network round-trip; on a busy run the processor falls behind. If we read
        # straight from the socket, OpenCode closes /event when /message returns
        # and the unread tail (subagent idle/done, parent tool `completed`) is lost
        # at the socket level. So a dedicated reader drains the socket into an
        # unbounded queue as fast as the stream produces events (never blocking on
        # a POST), and the processor below works through the queue at its own pace.
        # The pump finishes only when the stream has closed AND the queue is empty.
        queue: asyncio.Queue = asyncio.Queue()
        sentinel = object()

        async def reader() -> None:
            try:
                async with self.opencode_client.stream(
                    "GET",
                    sse_url,
                    timeout=httpx.Timeout(None, connect=self.HTTP_CONNECT_TIMEOUT, read=None),
                ) as sse_response:
                    if sse_response.status_code != 200:
                        self.log.warn(
                            "bridge.sse_connect_failed", status_code=sse_response.status_code
                        )
                        return
                    ready.set()
                    async for event in self._parse_sse_stream(sse_response):
                        queue.put_nowait(event)
            except asyncio.CancelledError:
                raise
            except Exception as e:  # noqa: BLE001 - telemetry is best-effort
                self.log.warn("bridge.telemetry_reader_error", exc=e)
            finally:
                ready.set()
                queue.put_nowait(sentinel)

        reader_task = asyncio.create_task(reader())
        try:
            while True:
                event = await queue.get()
                if event is sentinel:
                    break
                event_type = event.get("type")
                props = event.get("properties", {})
                if not isinstance(props, dict):
                    props = {}

                # Keepalives prove the connection is alive but carry no task
                # progress — they must NOT reset the inactivity watchdog, or a
                # genuinely stuck session would never be caught.
                if event_type in ("server.connected", "server.heartbeat", "session.status"):
                    continue

                self._last_activity = loop.time()

                now = loop.time()
                if now - last_progress_log >= 60.0:
                    last_progress_log = now
                    self.log.info(
                        "bridge.progress",
                        elapsed_s=round(now - start, 1),
                        pending=queue.qsize(),
                        subagents={sid: sa["description"] for sid, sa in subagents.items()},
                        steps={sid: sa["steps"] for sid, sa in subagents.items()},
                    )

                # ── session.created: register subagents (parentID == ours) ──
                if event_type == "session.created":
                    info = props.get("info", {})
                    sid = info.get("id", "")
                    if sid and sid != self.opencode_session_id and info.get("parentID"):
                        register_subagent(
                            sid, info.get("title") or f"Subagent {len(subagents) + 1}"
                        )
                        await self.post_event(
                            "subagent_event",
                            {
                                "subagent_session_id": sid,
                                "task_description": subagents[sid]["description"],
                                "event_type": "start",
                            },
                        )
                    continue

                # ── message.updated: learn message roles ───────────────────
                if event_type == "message.updated":
                    info = props.get("info", {})
                    mid = info.get("id", "")
                    if mid:
                        msg_roles[mid] = info.get("role", "")
                    continue

                # ── message.part.delta: streamed answer tokens ─────────────
                if event_type == "message.part.delta":
                    if props.get("field") != "text":
                        continue
                    if msg_roles.get(props.get("messageID", "")) != "assistant":
                        continue
                    part_id = props.get("partID", "")
                    # Reasoning parts also stream with field "text"; forward
                    # only parts we know are answer text (type seen earlier via
                    # message.part.updated). Emit the *fragment* — the UI appends.
                    if part_types.get(part_id) != "text":
                        continue
                    frag = props.get("delta", "")
                    if not frag:
                        continue
                    sid = props.get("sessionID", "")
                    if sid == self.opencode_session_id:
                        append_delta(parent_cumtext, part_id, frag)
                        await self.post_event("token", {"content": frag})
                    elif sid:
                        if sid not in subagents:
                            register_subagent(sid, f"Subagent {len(subagents) + 1}")
                        append_delta(subagents[sid]["cumulative_text"], part_id, frag)
                        await emit_subagent(sid, {"type": "token", "data": {"content": frag}})
                    continue

                # ── message.part.updated: tool calls, step markers, text ────
                if event_type == "message.part.updated":
                    part = props.get("part", {})
                    part_id = part.get("id", "")
                    ptype = part.get("type", "")
                    if part_id:
                        part_types[part_id] = ptype
                    if msg_roles.get(part.get("messageID", "")) != "assistant":
                        continue
                    sid = part.get("sessionID", "") or props.get("sessionID", "")
                    is_parent = sid == self.opencode_session_id
                    if not is_parent and sid and sid not in subagents:
                        register_subagent(sid, f"Subagent {len(subagents) + 1}")
                    cumtext = (
                        parent_cumtext
                        if is_parent
                        else subagents[sid]["cumulative_text"]
                        if sid in subagents
                        else {}
                    )

                    if ptype == "text":
                        # Catch up any answer text not delivered via delta;
                        # emit only the new suffix (the UI appends fragments).
                        frag = text_suffix(cumtext, part_id, part.get("text", ""))
                        if not frag:
                            continue
                        ev: dict[str, Any] = {"type": "token", "data": {"content": frag}}
                    else:
                        # Tool calls + step markers; reasoning → dropped.
                        transformed = self._transform_part_to_event(part)
                        if not transformed:
                            continue
                        ev = transformed
                        # Track tool state so we can flip anything left non-terminal
                        # to completed once the run is authoritatively done.
                        if ev["type"] == "tool_call":
                            cid = ev["data"].get("callId", "")
                            if cid:
                                tool_state[cid] = {
                                    "sid": sid,
                                    "is_parent": is_parent,
                                    "status": ev["data"].get("status", ""),
                                    "tool": ev["data"].get("tool", ""),
                                    "args": ev["data"].get("args", {}),
                                }

                    if is_parent:
                        await self.post_event(ev["type"], ev["data"])
                    elif sid in subagents:
                        await emit_subagent(sid, ev)
                    continue

                # ── session.idle: label subagent completion (parent ignored) ─
                if event_type == "session.idle":
                    sid = props.get("sessionID", "")
                    if sid in subagents:
                        sa = subagents[sid]
                        sa["done"] = True
                        self.log.info(
                            "bridge.subagent_idle",
                            sid=sid,
                            description=sa["description"],
                            steps=sa["steps"],
                        )
                        await self.post_event(
                            "subagent_event",
                            {
                                "subagent_session_id": sid,
                                "task_description": sa["description"],
                                "event_type": "done",
                            },
                        )
                    continue

        except asyncio.CancelledError:
            raise
        except Exception as e:  # noqa: BLE001 - telemetry is best-effort
            self.log.warn("bridge.telemetry_error", exc=e)
        finally:
            ready.set()
            reader_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader_task

    async def _request_opencode_stop(self, reason: str) -> bool:
        """Best-effort: tell OpenCode to abort the current session run."""
        if not self.opencode_client or not self.opencode_session_id:
            return False
        try:
            await self.opencode_client.post(
                f"{self.opencode_base_url}/session/{self.opencode_session_id}/abort",
                timeout=self.OPENCODE_REQUEST_TIMEOUT,
            )
            self.log.info("bridge.stop_requested", reason=reason)
            return True
        except Exception as e:  # noqa: BLE001
            self.log.warn("bridge.stop_request_error", reason=reason, exc=e)
            return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_error_message(error: object) -> str | None:
        """Pull a human message out of OpenCode's NamedError shape.

        OpenCode errors are ``{"name": ..., "data": {"message": ...}}``.
        """
        if not error:
            return None
        if isinstance(error, dict):
            data = error.get("data")
            if isinstance(data, dict) and "message" in data:
                return str(data["message"])
            message = error.get("message") or error.get("name")
            return str(message) if message else None
        return str(error)

    def _resolve_timeout_seconds(
        self, name: str, default: float, min_value: float, max_value: float
    ) -> float:
        """Read a clamped timeout override from env, defaulting on bad input."""
        raw = os.environ.get(name)
        if not raw:
            value = default
        else:
            try:
                value = float(raw)
            except ValueError:
                self.log.warn("bridge.timeout_invalid", timeout_name=name, raw=raw)
                value = default
        return max(min_value, min(value, max_value))


async def main() -> None:
    """Standalone entry point (the supervisor normally drives the bridge in-process).

    Provided for debugging: lets the bridge be run as ``python -m runtime.bridge``
    against an already-running OpenCode.
    """
    parser = argparse.ArgumentParser(description="CoReview agent bridge")
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--control-plane", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--opencode-port", type=int, default=OPENCODE_PORT)
    parser.add_argument("--prompt", required=True)
    args = parser.parse_args()

    configure_logging()
    bridge = AgentBridge(
        run_id=args.run_id,
        session_id=args.session_id,
        control_plane_url=args.control_plane,
        auth_token=args.token,
        opencode_port=args.opencode_port,
    )
    await bridge.run_review(args.prompt)


if __name__ == "__main__":
    asyncio.run(main())
