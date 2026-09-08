import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SANDBOX_PATHS } from "@pi-cloud-agent/protocol";

// The artifact is built from our source, never from the user's image. Providers
// transfer it through their SDK and execute installation only inside the VM.
function runtimeArchivePath(directory: string, machine: string): string {
  const architecture = { x86_64: "amd64", aarch64: "arm64" }[machine.trim()];
  if (!architecture) throw new Error(`unsupported sandbox architecture: ${machine.trim()}`);
  const root = directory || fileURLToPath(new URL("../runtime/dist/", import.meta.url));
  return resolve(root, `runtime-linux-${architecture}.tar.gz`);
}

export async function readRuntimeArchive(directory: string, machine: string): Promise<Buffer> {
  const path = runtimeArchivePath(directory, machine);
  return readFile(path).catch((cause: unknown) => {
    throw new Error("app runtime artifact is missing; run pnpm sandbox:runtime", { cause });
  });
}

export const runtimeUser = "pi-agent";

export function runtimeInstallCommand(archive: string): string {
  // archive is a provider-generated UUID path, never user input.
  return [
    "set -eu",
    "export PATH=/usr/sbin:/usr/bin:/sbin:/bin",
    "export DEBIAN_FRONTEND=noninteractive",
    ". /etc/os-release",
    'case "$ID:$VERSION_ID" in debian:12|debian:13|ubuntu:22.04|ubuntu:24.04) ;; *) echo "Supported project images: Debian 12/13 or Ubuntu 22.04/24.04" >&2; exit 1;; esac',
    "if ! command -v git >/dev/null || ! command -v gh >/dev/null || ! command -v bash >/dev/null || ! command -v useradd >/dev/null || ! dpkg-query -s libstdc++6 2>/dev/null | grep -q '^Status: install ok installed'; then",
    "  apt-get update",
    "  apt-get install -y --no-install-recommends bash ca-certificates git gh passwd libstdc++6",
    "fi",
    `id ${runtimeUser} >/dev/null 2>&1 || useradd --create-home --shell /bin/bash ${runtimeUser}`,
    `test "$(id -u ${runtimeUser})" != 0`,
    `rm -rf ${SANDBOX_PATHS.app}`,
    `mkdir -p ${SANDBOX_PATHS.app} /workspace/.pi-cloud-agent /workspace/.tmp`,
    `tar -xzf '${archive}' -C ${SANDBOX_PATHS.app} --no-same-owner`,
    // The unprivileged runtime user must be able to traverse this tree. A
    // locally repacked archive can otherwise extract as mode 700.
    `chmod -R a+rX ${SANDBOX_PATHS.app}`,
    `rm -f '${archive}'`,
    "chmod 1777 /workspace /workspace/.tmp",
    `chown ${runtimeUser}:${runtimeUser} /workspace/.pi-cloud-agent`,
    "chmod 700 /workspace/.pi-cloud-agent",
    `${SANDBOX_PATHS.app}/bin/node --version`,
  ].join("\n");
}
