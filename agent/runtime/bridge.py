"""Agent bridge: drive OpenCode and forward its events to the controller.

Our controller is a FastAPI service we
reach over plain HTTP, and the review is *outbound-driven* and single-shot: the
supervisor tells the bridge which prompt to run, the bridge injects it into
OpenCode, subscribes to OpenCode's ``/event`` SSE stream, and POSTs each derived
event to the controller. When OpenCode's parent session goes idle the review is
complete.

Controller HTTP API (base = ``CONTROL_PLANE_URL``; every call carries
``Authorization: Bearer ${SANDBOX_AUTH_TOKEN}``):

    POST /internal/runs/{RUN_ID}/events   {"type": str, "data": obj}
    POST /internal/runs/{RUN_ID}/status   {"status": str, "detail": str|null}

Findings are NOT sent here — the bundle's ``report_finding`` OpenCode tool POSTs
them directly to ``/internal/runs/{RUN_ID}/findings``.

OpenCode 1.16.2 server API the bridge drives:

    POST /session                              -> {"id": ...}             (create)
    GET  /session/{id}                         -> 200 if it still exists  (validate)
    GET  /event                                -> SSE stream of events
    POST /session/{id}/prompt_async            inject a prompt (async)
    POST /session/{id}/abort                   stop the in-flight run
    GET  /session/{id}/message                 final message state (text catch-up)

The ``OpenCodeIdentifier`` ascending-id scheme is kept verbatim from the
reference: it is what makes prompt injection work. OpenCode's prompt loop exits
early when ``lastUser.id < lastAssistant.id``, so the injected user message must
carry a monotonically-increasing id greater than any prior assistant message.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import secrets
import threading
import time
import urllib.error
import urllib.request
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any, ClassVar

import httpx

from .constants import OPENCODE_PORT, OPENCODE_SESSION_ID_FILE
from .log_config import configure_logging, get_logger


class OpenCodeIdentifier:
    """Generate OpenCode-compatible ascending ids.

    Port of OpenCode's TypeScript id generator. Format::

        {prefix}_{timestamp_hex}{random_base62}

    - prefix: type identifier ("msg" for messages, "ses" for sessions, …)
    - timestamp_hex: 12 hex chars encoding (timestamp_ms * 0x1000 + counter)
    - random_base62: 14 random base62 characters

    Ids are monotonically increasing, so a newly-injected user message always
    has an id greater than previous assistant messages — required for OpenCode's
    prompt loop (lastUser.id < lastAssistant.id triggers an early exit).

    Uses class-level state for monotonic generation. Safe for async code but
    NOT thread-safe.
    """

    PREFIXES: ClassVar[dict[str, str]] = {
        "session": "ses",
        "message": "msg",
        "part": "prt",
    }
    BASE62_CHARS: ClassVar[str] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    RANDOM_LENGTH: ClassVar[int] = 14

    _last_timestamp: ClassVar[int] = 0
    _counter: ClassVar[int] = 0

    @classmethod
    def ascending(cls, prefix: str) -> str:
        """Generate an ascending id with the given prefix."""
        if prefix not in cls.PREFIXES:
            raise ValueError(f"Unknown prefix: {prefix}")

        prefix_str = cls.PREFIXES[prefix]
        current_timestamp = int(time.time() * 1000)

        if current_timestamp != cls._last_timestamp:
            cls._last_timestamp = current_timestamp
            cls._counter = 0
        cls._counter += 1

        encoded = current_timestamp * 0x1000 + cls._counter
        encoded_48bit = encoded & 0xFFFFFFFFFFFF
        timestamp_bytes = encoded_48bit.to_bytes(6, byteorder="big")
        timestamp_hex = timestamp_bytes.hex()
        random_suffix = cls._random_base62(cls.RANDOM_LENGTH)

        return f"{prefix_str}_{timestamp_hex}{random_suffix}"

    @classmethod
    def _random_base62(cls, length: int) -> str:
        """Generate a random base62 string."""
        return "".join(cls.BASE62_CHARS[secrets.randbelow(62)] for _ in range(length))


class SSEConnectionError(Exception):
    """Raised when the OpenCode SSE connection fails."""


class AgentBridge:
    """Bridge between the sandbox's OpenCode instance and the controller.

    Responsibilities:
      * create/attach an OpenCode session;
      * inject the initial review prompt;
      * subscribe to OpenCode's ``/event`` SSE stream and forward derived events
        to the controller over HTTP;
      * post a terminal ``{"status": "done"}`` when the parent session goes idle
        (or ``{"status": "error", ...}`` on failure).
    """

    # Tunables ported from the reference (seconds).
    SSE_INACTIVITY_TIMEOUT = 120.0
    SSE_INACTIVITY_TIMEOUT_MIN = 5.0
    SSE_INACTIVITY_TIMEOUT_MAX = 3600.0
    HTTP_CONNECT_TIMEOUT = 30.0
    HTTP_DEFAULT_TIMEOUT = 30.0
    OPENCODE_REQUEST_TIMEOUT = 30.0
    PROMPT_MAX_DURATION = 5400.0
    MAX_PENDING_PART_EVENTS = 2000

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

        # Two clients: a short-timeout one for controller POSTs and OpenCode
        # request/response calls, and a streaming client for the SSE stream,
        # which is opened with no read timeout inside the streaming context.
        self.http_client: httpx.AsyncClient | None = None
        self.opencode_client: httpx.AsyncClient | None = None

    # ------------------------------------------------------------------
    # Controller transport (replaces the reference's WebSocket _send_event)
    # ------------------------------------------------------------------

    @property
    def _auth_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.auth_token}"}

    async def post_event(self, event_type: str, data: dict[str, Any]) -> None:
        """Forward a single OpenCode-derived event to the controller.

        POST /internal/runs/{RUN_ID}/events  {"type", "data"}. Best-effort: a
        transient controller hiccup must not abort the review, so failures are
        logged and swallowed (the SSE stream is the source of truth).
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
        the run on the controller side, so unlike events this is logged loud: we
        report failures at error level.
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
        """Drive a full review: inject ``prompt``, stream events, post done.

        Returns True if the review completed (OpenCode went idle), False if it
        ended in an error. Posts a terminal status to the controller either way.
        """
        self.log.info(
            "bridge.run_start",
            sse_inactivity_timeout_s=self.sse_inactivity_timeout,
        )
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

            had_error = False
            error_message: str | None = None
            async for event in self._stream_opencode_response_sse(prompt):
                if event.get("type") == "error":
                    had_error = True
                    error_message = event.get("data", {}).get("error")
                await self.post_event(event["type"], event.get("data", {}))

            if had_error:
                self.log.error("bridge.review_error", error=error_message)
                await self.post_status("error", detail=error_message)
                return False

            self.log.info("bridge.review_complete")
            await self.post_status("done")
            return True

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
        """Create a fresh OpenCode session and persist its id.

        Mirrors the reference: POST ``/session`` with an empty body, read ``id``.
        """
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
        """Re-attach to a persisted OpenCode session id if it's still valid.

        Mirrors the reference: GET ``/session/{id}``; a non-200 means the
        session is gone and we fall back to creating a fresh one.
        """
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
    # Prompt injection + SSE streaming (ported from the reference)
    # ------------------------------------------------------------------

    def _build_prompt_request_body(
        self, content: str, opencode_message_id: str
    ) -> dict[str, Any]:
        """Build the OpenCode ``prompt_async`` request body.

        The model is configured globally via ``OPENCODE_CONFIG_CONTENT`` (set by
        the supervisor), so we don't override it per-prompt. ``messageID`` is the
        ascending id that makes the injected user message sort after any prior
        assistant message — exactly as the reference does it.
        """
        return {
            "messageID": opencode_message_id,
            "parts": [{"type": "text", "text": content}],
        }

    async def _parse_sse_stream(
        self,
        response: httpx.Response,
    ) -> AsyncIterator[dict[str, Any]]:
        """Parse the OpenCode Server-Sent-Events stream.

        SSE events are ``data: {json}`` blocks separated by blank lines.
        Timeout rescheduling is intentionally NOT done here — the caller resets
        the deadline only on meaningful events, so heartbeats don't mask stuck
        subagents.
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

    def _transform_part_to_event(
        self, part: dict[str, Any], delta: Any
    ) -> dict[str, Any] | None:
        """Map an OpenCode message part to a controller event envelope.

        Returns ``{"type": ..., "data": {...}}`` or ``None`` to drop the part.
        Part shapes (``text``/``tool``/``step-*`` and the tool ``state`` keys)
        match OpenCode 1.16.2 message parts.
        """
        part_type = part.get("type", "")

        if part_type == "text":
            # OpenCode streams incremental text via `delta`; when present we
            # forward just the new fragment as a token, falling back to the full
            # part text for non-streaming updates.
            text = delta if delta else part.get("text", "")
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

    @staticmethod
    def _extract_error_message(error: object) -> str | None:
        """Pull a human message out of OpenCode's NamedError shape.

        OpenCode errors are ``{"name": ..., "data": {"message": ...}}``.
        """
        if isinstance(error, dict):
            data = error.get("data")
            if isinstance(data, dict) and "message" in data:
                return str(data["message"])
            message = error.get("message") or error.get("name")
            return str(message) if message else None
        return str(error) if error else None

    async def _stream_opencode_response_sse(self, content: str) -> AsyncIterator[dict[str, Any]]:
        """Inject the prompt and stream OpenCode's response as controller events.

        Flow for OpenCode 1.16.2 (note: 1.16.2 does not fire ``session.idle``
        after the parent's final step when subagents are used — termination is
        instead detected from ``step_finish`` with a non-tool-call reason):
          1. open the SSE stream (``GET /event``);
          2. POST the prompt to ``/session/{id}/prompt_async`` with an ascending
             ``messageID``;
          3. forward parts of assistant messages whose ``parentID`` equals our
             injected message id (filters out unrelated/cached chatter);
          4. track subagent sessions spawned by ``task`` tool calls and forward
             their events as ``subagent_event`` type;
          5. terminate on the parent session's ``session.idle`` event.

        The SSE stream MUST be opened before posting the prompt to avoid missing
        early events. Parts that arrive before their owning ``message.updated``
        authorizes the message id are buffered and replayed on authorization.

        Hang-safety: the inactivity timeout is reset only on meaningful events,
        NOT on ``server.heartbeat`` — so a stuck subagent that produces no real
        output will time out in ``sse_inactivity_timeout`` seconds rather than
        running until ``PROMPT_MAX_DURATION``.
        """
        assert self.opencode_client is not None and self.opencode_session_id

        opencode_message_id = OpenCodeIdentifier.ascending("message")
        request_body = self._build_prompt_request_body(content, opencode_message_id)

        sse_url = f"{self.opencode_base_url}/event"
        async_url = (
            f"{self.opencode_base_url}/session/{self.opencode_session_id}/prompt_async"
        )

        # --- Parent-session state ---
        cumulative_text: dict[str, str] = {}
        allowed_assistant_msg_ids: set[str] = set()
        # Parts buffered before their owning message was authorized.
        pending_parts: dict[str, list[tuple[dict[str, Any], Any]]] = {}
        pending_parts_total = 0
        loop = asyncio.get_running_loop()

        # --- Subagent-session state ---
        # session_id → {description, allowed_msg_ids, cumulative_text}
        subagent_sessions: dict[str, dict[str, Any]] = {}
        # Task descriptions extracted from parent tool_calls, correlated to the
        # next new subagent session that appears in the stream.
        pending_task_descs: list[str] = []



        def buffer_part(oc_msg_id: str, part: dict[str, Any], delta: Any) -> bool:
            nonlocal pending_parts_total
            if pending_parts_total >= self.MAX_PENDING_PART_EVENTS:
                return False
            pending_parts.setdefault(oc_msg_id, []).append((part, delta))
            pending_parts_total += 1
            return True

        def _apply_cumtext(
            ev: dict[str, Any],
            part: dict[str, Any],
            delta: Any,
            cumtext: dict[str, str],
        ) -> None:
            """Update cumulative text tracking in-place for token events."""
            if ev["type"] != "token":
                return
            part_id = part.get("id", "")
            if delta:
                cumtext[part_id] = cumtext.get(part_id, "") + str(delta)
                ev["data"]["content"] = cumtext[part_id]
            else:
                cumtext[part_id] = str(part.get("text", ""))

        def emit_part(part: dict[str, Any], delta: Any) -> dict[str, Any] | None:
            ev = self._transform_part_to_event(part, delta)
            if ev:
                _apply_cumtext(ev, part, delta, cumulative_text)
            return ev

        def emit_subagent_part(
            sid: str, part: dict[str, Any], delta: Any
        ) -> dict[str, Any] | None:
            ev = self._transform_part_to_event(part, delta)
            if not ev:
                return None
            sa = subagent_sessions[sid]
            _apply_cumtext(ev, part, delta, sa["cumulative_text"])

            return {
                "type": "subagent_event",
                "data": {
                    "subagent_session_id": sid,
                    "task_description": sa["description"],
                    "event_type": ev["type"],
                    **ev["data"],
                },
            }

        watchdog_fired = False
        watchdog_reason = ""
        watchdog_thread: threading.Thread | None = None
        watchdog_stop = threading.Event()
        current_task = asyncio.current_task()
        last_meaningful_activity = loop.time()

        def watchdog() -> None:
            nonlocal watchdog_fired, watchdog_reason
            self.log.info("bridge.watchdog_start", timeout_s=self.sse_inactivity_timeout)
            while not watchdog_stop.is_set():
                remaining = (
                    last_meaningful_activity + self.sse_inactivity_timeout - loop.time()
                )
                if remaining <= 0:
                    watchdog_fired = True
                    watchdog_reason = (
                        f"SSE stream inactive for {self.sse_inactivity_timeout:.0f}s "
                        "(no meaningful events)."
                    )
                    data = {
                        "level": "error",
                        "message": (
                            "bridge.inactivity_timeout "
                            f"timeout_s={self.sse_inactivity_timeout} "
                            f"elapsed_s={round(loop.time() - prompt_start, 1)}"
                        ),
                        "logger": "bridge",
                    }
                    self._post_controller_sync(
                        "events",
                        {"type": "log", "data": data},
                    )
                    self._post_controller_sync(
                        "status",
                        {"status": "error", "detail": watchdog_reason},
                    )
                    self._request_opencode_stop_sync("inactivity_timeout")
                    if current_task:
                        loop.call_soon_threadsafe(current_task.cancel)
                    return
                watchdog_stop.wait(min(remaining, 5.0))

        try:
            async with self.opencode_client.stream(
                    "GET",
                    sse_url,
                    timeout=httpx.Timeout(None, connect=self.HTTP_CONNECT_TIMEOUT, read=None),
                ) as sse_response:
                    if sse_response.status_code != 200:
                        raise SSEConnectionError(
                            f"SSE connection failed: {sse_response.status_code}"
                        )

                    prompt_start = loop.time()
                    last_meaningful_activity = prompt_start
                    watchdog_thread = threading.Thread(
                        target=watchdog,
                        name="bridge-inactivity-watchdog",
                        daemon=True,
                    )
                    watchdog_thread.start()
                    prompt_response = await self.opencode_client.post(
                        async_url,
                        json=request_body,
                        timeout=self.OPENCODE_REQUEST_TIMEOUT,
                    )
                    if prompt_response.status_code not in (200, 204):
                        self.log.error(
                            "bridge.prompt_request_error",
                            status_code=prompt_response.status_code,
                            error_body=prompt_response.text,
                        )
                        raise RuntimeError(
                            f"Async prompt failed: {prompt_response.status_code} - "
                            f"{prompt_response.text}"
                        )

                    def mark_meaningful_activity() -> None:
                        nonlocal last_meaningful_activity
                        last_meaningful_activity = loop.time()

                    async for event in self._parse_sse_stream(sse_response):
                        event_type = event.get("type")
                        props = event.get("properties", {})
                        if not isinstance(props, dict):
                            props = {}

                        # Hard wall-clock guard: checked first on every event so it
                        # fires regardless of which branch handles the event.
                        if loop.time() > prompt_start + self.PROMPT_MAX_DURATION:
                            self.log.error(
                                "bridge.prompt_max_duration_exceeded",
                                max_s=self.PROMPT_MAX_DURATION,
                            )
                            await self._request_opencode_stop("prompt_max_duration_timeout")
                            async for fe in self._fetch_final_message_state(
                                opencode_message_id,
                                cumulative_text,
                                allowed_assistant_msg_ids,
                            ):
                                yield fe
                            raise RuntimeError(
                                f"Prompt exceeded max duration of {self.PROMPT_MAX_DURATION:.0f}s."
                            )

                        # Heartbeats and session.status keepalives do NOT reset the
                        # inactivity timeout — this is intentional. Both are periodic
                        # OpenCode signals that prove the TCP connection is alive but
                        # carry no task progress. A genuinely stuck session (bash hung,
                        # subagent looping, no tokens) must time out in
                        # sse_inactivity_timeout seconds rather than run to
                        # PROMPT_MAX_DURATION because these keepalives keep firing.
                        if event_type in ("server.connected", "server.heartbeat"):
                            continue

                        # session.status is OpenCode's per-session keepalive. It must
                        # never reset the timeout unless it is the parent idle signal.
                        if event_type == "session.status":
                            status = props.get("status", {})
                            sid = props.get("sessionID", "")
                            self.log.debug(
                                "bridge.session_status",
                                sid=sid,
                                status_type=status.get("type") if isinstance(status, dict) else status,
                                is_parent=sid == self.opencode_session_id,
                            )
                            if (
                                sid == self.opencode_session_id
                                and isinstance(status, dict)
                                and status.get("type") == "idle"
                            ):
                                self.log.info("bridge.parent_idle")
                                async for fe in self._fetch_final_message_state(
                                    opencode_message_id,
                                    cumulative_text,
                                    allowed_assistant_msg_ids,
                                ):
                                    yield fe
                                return
                            continue  # non-idle status — no reschedule, no further processing

                        # ── message.updated ──────────────────────────────────────
                        if event_type == "message.updated":
                            info = props.get("info", {})
                            sid = info.get("sessionID", "")

                            if sid == self.opencode_session_id:
                                # Parent session: authorize assistant messages.
                                if info.get("role") != "assistant":
                                    continue
                                oc_msg_id = info.get("id", "")
                                if (
                                    oc_msg_id
                                    and info.get("parentID") == opencode_message_id
                                    and oc_msg_id not in allowed_assistant_msg_ids
                                ):
                                    mark_meaningful_activity()
                                    allowed_assistant_msg_ids.add(oc_msg_id)
                                    replay = pending_parts.pop(oc_msg_id, [])
                                    if replay:
                                        pending_parts_total -= len(replay)
                                        for part, delta in replay:
                                            ev = emit_part(part, delta)
                                            if ev:
                                                yield ev
                            elif sid:
                                # Subagent session: register if new, authorize msgs.
                                if sid not in subagent_sessions:
                                    mark_meaningful_activity()
                                    desc = (
                                        pending_task_descs.pop(0)
                                        if pending_task_descs
                                        else f"Task {len(subagent_sessions) + 1}"
                                    )
                                    subagent_sessions[sid] = {
                                        "description": desc,
                                        "allowed_msg_ids": set(),
                                        "cumulative_text": {},
                                    }
                                    self.log.info(
                                        "bridge.subagent_start",
                                        subagent_session_id=sid,
                                        description=desc,
                                    )
                                    yield {
                                        "type": "subagent_event",
                                        "data": {
                                            "subagent_session_id": sid,
                                            "task_description": desc,
                                            "event_type": "start",
                                        },
                                    }
                                if info.get("role") == "assistant":
                                    sa_msg_id = info.get("id", "")
                                    if (
                                        sa_msg_id
                                        and sa_msg_id
                                        not in subagent_sessions[sid]["allowed_msg_ids"]
                                    ):
                                        mark_meaningful_activity()
                                        subagent_sessions[sid]["allowed_msg_ids"].add(sa_msg_id)
                                        # Replay buffered parts that arrived early.
                                        replay = pending_parts.pop(sa_msg_id, [])
                                        if replay:
                                            pending_parts_total -= len(replay)
                                            for part, delta in replay:
                                                sa_ev = emit_subagent_part(sid, part, delta)
                                                if sa_ev:
                                                    yield sa_ev
                            continue

                        # ── message.part.updated ─────────────────────────────────
                        if event_type == "message.part.updated":
                            part = props.get("part", {})
                            delta = props.get("delta")
                            oc_msg_id = part.get("messageID", "")

                            if oc_msg_id in allowed_assistant_msg_ids:
                                ev = emit_part(part, delta)
                                if ev:
                                    mark_meaningful_activity()
                                    # Capture task description for subagent correlation.
                                    if (
                                        ev["type"] == "tool_call"
                                        and ev["data"].get("tool") == "task"
                                        and ev["data"].get("status") in ("pending", "running")
                                    ):
                                        desc = (ev["data"].get("args") or {}).get(
                                            "description", ""
                                        )
                                        if desc:
                                            pending_task_descs.append(desc)
                                    yield ev
                                    # OpenCode 1.16.2 does not fire session.idle after the
                                    # parent's final step — detect completion via step_finish
                                    # with a non-tool-call reason ("stop", "end_turn", "length").
                                    if (
                                        ev["type"] == "log"
                                        and ev["data"].get("event") == "step_finish"
                                        and ev["data"].get("reason") not in (
                                            None, "tool_use", "tool-calls", "tool_result"
                                        )
                                    ):
                                        self.log.info(
                                            "bridge.parent_idle",
                                            reason=ev["data"].get("reason"),
                                        )
                                        async for fe in self._fetch_final_message_state(
                                            opencode_message_id,
                                            cumulative_text,
                                            allowed_assistant_msg_ids,
                                        ):
                                            yield fe
                                        return
                            else:
                                # Check subagent sessions first, then buffer.
                                matched = False
                                for sid, sa in subagent_sessions.items():
                                    if oc_msg_id in sa["allowed_msg_ids"]:
                                        sa_ev = emit_subagent_part(sid, part, delta)
                                        if sa_ev:
                                            mark_meaningful_activity()
                                            yield sa_ev
                                        matched = True
                                        break
                                if not matched and oc_msg_id:
                                    buffer_part(oc_msg_id, part, delta)
                            continue

                        # ── session.idle ─────────────────────────────────────────
                        if event_type == "session.idle":
                            sid = props.get("sessionID", "")
                            is_parent = sid == self.opencode_session_id
                            is_known_subagent = sid in subagent_sessions
                            self.log.info(
                                "bridge.session_idle",
                                sid=sid,
                                is_parent=is_parent,
                                is_known_subagent=is_known_subagent,
                                known_subagent_count=len(subagent_sessions),
                                elapsed_s=round(loop.time() - prompt_start, 1),
                            )
                            if is_parent:
                                self.log.info("bridge.parent_idle")
                                async for fe in self._fetch_final_message_state(
                                    opencode_message_id,
                                    cumulative_text,
                                    allowed_assistant_msg_ids,
                                ):
                                    yield fe
                                return
                            elif is_known_subagent:
                                sa = subagent_sessions[sid]
                                self.log.info(
                                    "bridge.subagent_idle",
                                    sid=sid,
                                    description=sa["description"],
                                )
                                yield {
                                    "type": "subagent_event",
                                    "data": {
                                        "subagent_session_id": sid,
                                        "task_description": sa["description"],
                                        "event_type": "done",
                                    },
                                }
                            else:
                                self.log.warn("bridge.session_idle_unknown_sid", sid=sid)
                            continue

                        if event_type == "session.error":
                            if props.get("sessionID") == self.opencode_session_id:
                                error_msg = self._extract_error_message(props.get("error", {}))
                                self.log.error("bridge.session_error", error_msg=error_msg)
                                yield {
                                    "type": "error",
                                    "data": {"error": error_msg or "Unknown error"},
                                }
                                return
                            continue

                        if loop.time() > prompt_start + self.PROMPT_MAX_DURATION:
                            await self._request_opencode_stop("prompt_max_duration_timeout")
                            async for fe in self._fetch_final_message_state(
                                opencode_message_id,
                                cumulative_text,
                                allowed_assistant_msg_ids,
                            ):
                                yield fe
                            raise RuntimeError(
                                f"Prompt exceeded max duration of {self.PROMPT_MAX_DURATION:.0f}s."
                            )

        except asyncio.CancelledError as e:
            if watchdog_fired:
                raise RuntimeError(watchdog_reason) from e
            raise
        except httpx.ReadError as e:
            raise SSEConnectionError(f"SSE read error: {e}") from e
        finally:
            watchdog_stop.set()
            if watchdog_thread and watchdog_thread.is_alive():
                watchdog_thread.join(timeout=1.0)

    async def _fetch_final_message_state(
        self,
        opencode_message_id: str,
        cumulative_text: dict[str, str],
        tracked_msg_ids: set[str],
    ) -> AsyncIterator[dict[str, Any]]:
        """Emit any text missed due to SSE ordering, after the session goes idle.

        Mirrors the reference: GET ``/session/{id}/message`` and, for assistant
        messages parented to our prompt (or already tracked during streaming),
        emit any text part longer than what we already forwarded.
        """
        if not self.opencode_client or not self.opencode_session_id:
            return

        messages_url = f"{self.opencode_base_url}/session/{self.opencode_session_id}/message"
        try:
            response = await self.opencode_client.get(
                messages_url,
                timeout=self.OPENCODE_REQUEST_TIMEOUT,
            )
            if response.status_code != 200:
                self.log.warn("bridge.final_state_fetch_error", status_code=response.status_code)
                return
            messages = response.json()
        except Exception as e:  # noqa: BLE001
            self.log.error("bridge.final_state_error", exc=e)
            return

        for msg in messages:
            info = msg.get("info", {})
            if info.get("role") != "assistant":
                continue
            msg_id = info.get("id", "")
            parent_matches = info.get("parentID", "") == opencode_message_id
            if not (parent_matches or msg_id in tracked_msg_ids):
                continue
            for part in msg.get("parts", []):
                if part.get("type") != "text":
                    continue
                part_id = part.get("id", "")
                text = part.get("text", "")
                if len(text) > len(cumulative_text.get(part_id, "")):
                    cumulative_text[part_id] = text
                    yield {"type": "token", "data": {"content": text}}

    async def _request_opencode_stop(self, reason: str) -> bool:
        """Best-effort: tell OpenCode to abort the current session run.

        Mirrors the reference abort route ``POST /session/{id}/abort``.
        """
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

    def _post_controller_sync(self, kind: str, payload: dict[str, Any]) -> bool:
        """Thread-safe watchdog fallback: POST directly without the event loop."""
        try:
            data = json.dumps(payload).encode()
            req = urllib.request.Request(
                f"{self.control_plane_url}/internal/runs/{self.run_id}/{kind}",
                data=data,
                headers={
                    "Authorization": f"Bearer {self.auth_token}",
                    "Content-Type": "application/json",
                },
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self.HTTP_DEFAULT_TIMEOUT) as resp:
                return 200 <= resp.status < 300
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            self.log.warn("bridge.sync_controller_post_error", kind=kind, exc=e)
            return False

    def _request_opencode_stop_sync(self, reason: str) -> bool:
        """Thread-safe watchdog fallback: abort OpenCode without the event loop."""
        if not self.opencode_session_id:
            return False
        try:
            req = urllib.request.Request(
                f"{self.opencode_base_url}/session/{self.opencode_session_id}/abort",
                data=b"",
                method="POST",
            )
            with urllib.request.urlopen(req, timeout=self.OPENCODE_REQUEST_TIMEOUT) as resp:
                ok = 200 <= resp.status < 300
            self.log.info("bridge.stop_requested", reason=reason, sync=True)
            return ok
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            self.log.warn("bridge.stop_request_error", reason=reason, sync=True, exc=e)
            return False

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

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

    Provided for parity with the reference and for debugging: it lets the bridge
    be run as ``python -m runtime.bridge`` against an already-running OpenCode.
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
