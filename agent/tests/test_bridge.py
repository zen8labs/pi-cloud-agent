from __future__ import annotations

import asyncio

import pytest

from runtime.bridge import AgentBridge


class _FakeResponse:
    def __init__(self, status_code: int, payload: object) -> None:
        self.status_code = status_code
        self._payload = payload

    def json(self) -> object:
        return self._payload


class _FakeClient:
    def __init__(self, responses: dict[str, _FakeResponse]) -> None:
        self._responses = responses

    async def get(self, url: str, timeout: float | object = None) -> _FakeResponse:
        return self._responses[url]


class _HangingClient:
    async def get(self, url: str, timeout: float | object = None) -> _FakeResponse:
        await asyncio.sleep(3600)
        raise AssertionError("unreachable")


@pytest.mark.asyncio
async def test_final_subagent_text_events_backfills_missing_suffixes():
    bridge = AgentBridge("run-1", "sess-1", "http://controller", "token")
    sid = "sub-1"
    bridge._subagents = {
        sid: {
            "description": "Inspect repo",
            "cumulative_text": {"part-1": "Hello "},
            "steps": 0,
        }
    }
    bridge.opencode_client = _FakeClient(
        {
            "http://localhost:4096/session/sub-1/message": _FakeResponse(
                200,
                [
                    {
                        "info": {"role": "assistant"},
                        "parts": [
                            {"id": "part-1", "type": "text", "text": "Hello world"},
                            {"id": "part-2", "type": "reasoning", "text": "hidden"},
                        ],
                    },
                    {
                        "info": {"role": "user"},
                        "parts": [{"id": "part-u", "type": "text", "text": "prompt"}],
                    },
                ],
            )
        }
    )

    events = await bridge._final_subagent_text_events()

    assert events == [
        {
            "type": "subagent_event",
            "data": {
                "subagent_session_id": "sub-1",
                "task_description": "Inspect repo",
                "event_type": "token",
                "content": "world",
            },
        }
    ]
    assert bridge._subagents[sid]["cumulative_text"] == {"part-1": "Hello world"}


@pytest.mark.asyncio
async def test_final_subagent_text_events_ignores_failed_history_fetch():
    bridge = AgentBridge("run-1", "sess-1", "http://controller", "token")
    sid = "sub-1"
    bridge._subagents = {
        sid: {
            "description": "Inspect repo",
            "cumulative_text": {},
            "steps": 0,
        }
    }
    bridge.opencode_client = _FakeClient(
        {
            "http://localhost:4096/session/sub-1/message": _FakeResponse(404, {"error": "missing"})
        }
    )

    assert await bridge._final_subagent_text_events() == []


@pytest.mark.asyncio
async def test_final_subagent_text_events_times_out_hanging_fetch():
    bridge = AgentBridge("run-1", "sess-1", "http://controller", "token")
    bridge.SUBAGENT_HISTORY_TIMEOUT = 0.01
    bridge._subagents = {
        "sub-1": {
            "description": "Inspect repo",
            "cumulative_text": {},
            "steps": 0,
        }
    }
    bridge.opencode_client = _HangingClient()

    assert await bridge._final_subagent_text_events() == []
