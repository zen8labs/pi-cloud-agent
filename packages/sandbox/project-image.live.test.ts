import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { SANDBOX_PATHS, type SandboxRef, type WorkspaceRef } from "@pi-cloud-agent/protocol";
import { expect, it } from "vitest";
import { createMicroSandboxProvider } from "./microsandbox";

// Explicit opt-in: pnpm vitest run --project live packages/sandbox/project-image.live.test.ts
// Requires microSandbox and pnpm sandbox:runtime; no model or forge credentials.
it.each(["debian:12-slim", "ubuntu:22.04"])(
  "installs the agent into %s and preserves project work across resume",
  async (image) => {
    let report: (value: string) => void = () => undefined;
    const server = createServer((request, response) => {
      response.end("ok");
      report(request.url ?? "");
    });
    server.listen(0, "0.0.0.0");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test listener");
    const callback = `http://host.microsandbox.internal:${address.port}`;
    const provider = createMicroSandboxProvider({});
    let live: SandboxRef | undefined;
    let workspace: WorkspaceRef | undefined;
    const command = (warm: boolean) => {
      const code = [
        "await import('@earendil-works/pi-coding-agent')",
        "const fs = await import('node:fs/promises')",
        warm
          ? "if (await fs.readFile('/workspace/project-proof', 'utf8') !== 'preserved') throw Error('lost workspace')"
          : "await fs.writeFile('/workspace/project-proof', 'preserved')",
        "if (process.getuid() === 0) throw Error('agent must not run as root')",
        `await fetch('${callback}/${warm ? "warm" : "cold"}')`,
      ].join("; ");
      return `cd ${SANDBOX_PATHS.app} && ./bin/node --import tsx -e '${code.replaceAll("'", "'\\''")}'`;
    };
    const spec = {
      runId: randomUUID(),
      image,
      timeoutSeconds: 300,
      env: { CONTROL_PLANE_URL: callback },
      secrets: {},
      command: command(false),
    };
    try {
      const cold = new Promise<string>((resolve) => {
        report = resolve;
      });
      live = await provider.create(spec);
      expect(await withReportTimeout(cold)).toBe("/cold");
      workspace = await provider.suspend(live);
      await provider.finalizeSuspend(live, workspace);
      live = undefined;
      const warm = new Promise<string>((resolve) => {
        report = resolve;
      });
      live = await provider.resume(workspace, {
        ...spec,
        runId: randomUUID(),
        command: command(true),
      });
      expect(await withReportTimeout(warm)).toBe("/warm");
    } finally {
      if (live) await provider.stop(live);
      if (workspace) await provider.deleteWorkspace(workspace);
      server.close();
    }
  },
);

async function withReportTimeout(report: Promise<string>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      report,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("sandbox did not report within 30s")),
          30_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
