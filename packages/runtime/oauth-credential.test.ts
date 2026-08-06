import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeConfig } from "./config";
import { persistRefreshedOAuthCredential } from "./oauth-credential";
import type { Reporter } from "./reporter";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

it("captures Pi's rotated refresh token before the run-local auth file is deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-oauth-refresh-test-"));
  directories.push(directory);
  const authPath = join(directory, "auth.json");
  const previous = { type: "oauth", access: "expired", refresh: "refresh-1", expires: 1 };
  const rotated = { type: "oauth", access: "fresh", refresh: "refresh-2", expires: 2 };
  await writeFile(authPath, JSON.stringify({ "openai-codex": rotated }));
  const modelCredential = vi.fn(async () => true);
  const reporter: Reporter = {
    event: vi.fn(),
    log: vi.fn(),
    status: vi.fn(),
    modelCredential,
    flush: vi.fn(),
  };
  const config = {
    model: {
      provider: "openai-codex",
      authJson: JSON.stringify(previous),
    },
  } as RuntimeConfig;

  await persistRefreshedOAuthCredential(config, reporter, authPath);
  await rm(directory, { recursive: true });

  expect(modelCredential).toHaveBeenCalledWith({ previous, credential: rotated });
  await expect(readFile(authPath)).rejects.toMatchObject({ code: "ENOENT" });
});
