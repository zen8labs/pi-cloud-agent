"""Outbound-only reporting from the sandbox to the controller."""

from __future__ import annotations

import asyncio
import queue

import httpx

from .config import RuntimeConfig


class ControlReporter:
    def __init__(self, config: RuntimeConfig, log) -> None:
        self.config = config
        self.log = log

    @property
    def enabled(self) -> bool:
        return bool(
            self.config.control_plane_url
            and self.config.run_id
            and self.config.sandbox_token
        )

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.config.sandbox_token}"}

    async def status(self, status: str, detail: str | None = None) -> None:
        if not self.enabled:
            return
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                await client.post(
                    f"{self.config.control_plane_url.rstrip('/')}/internal/runs/"
                    f"{self.config.run_id}/status",
                    json={"status": status, "detail": detail},
                    headers=self.headers,
                )
        except Exception as error:  # noqa: BLE001
            self.log.error("supervisor.report_status_failed", exc=error)

    async def forward_logs(
        self,
        log_queue: queue.Queue,
        stopped: asyncio.Event,
    ) -> None:
        if not self.enabled:
            return
        url = (
            f"{self.config.control_plane_url.rstrip('/')}/internal/runs/"
            f"{self.config.run_id}/events"
        )
        async with httpx.AsyncClient(timeout=5.0, headers=self.headers) as client:
            while not stopped.is_set() or not log_queue.empty():
                try:
                    item = log_queue.get_nowait()
                except queue.Empty:
                    await asyncio.sleep(0.4)
                    continue
                try:
                    await client.post(url, json={"type": "log", "data": item})
                except Exception:  # noqa: BLE001
                    pass
