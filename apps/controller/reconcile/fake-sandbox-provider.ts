import {
  type SandboxError,
  type SandboxProvider,
  type SandboxSpec,
  WorkspaceNotFoundError,
} from "@pi-cloud-agent/protocol";

/** A sandbox provider that records what it was asked to do. */
export function fakeProvider(
  behavior: { failWith?: SandboxError; resumeMissing?: boolean } = {},
): SandboxProvider & {
  created: SandboxSpec[];
  resumeSpecs: SandboxSpec[];
  stopped: string[];
  resumed: string[];
  suspended: string[];
  deleted: string[];
} {
  const created: SandboxSpec[] = [];
  const resumeSpecs: SandboxSpec[] = [];
  const stopped: string[] = [];
  const resumed: string[] = [];
  const suspended: string[] = [];
  const deleted: string[] = [];
  return {
    name: "fake",
    created,
    resumeSpecs,
    stopped,
    resumed,
    suspended,
    deleted,
    async create(spec) {
      if (behavior.failWith) throw behavior.failWith;
      created.push(spec);
      return { provider: "fake", id: `sb-${created.length}` };
    },
    async resume(ref, spec) {
      if (behavior.resumeMissing) throw new WorkspaceNotFoundError("workspace expired");
      resumed.push(ref.id);
      resumeSpecs.push(spec);
      return { provider: "fake", id: ref.id };
    },
    async suspend(ref) {
      suspended.push(ref.id);
      return { provider: "fake", id: ref.id };
    },
    async deleteWorkspace(ref) {
      deleted.push(ref.id);
    },
    async stop(ref) {
      stopped.push(ref.id);
    },
  };
}
