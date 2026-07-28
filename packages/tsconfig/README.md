# @pi-cloud-agent/tsconfig

Shared compiler options, so strictness is set once.

| File | Extended by |
|---|---|
| `base.json` | everything — strict, `noUncheckedIndexedAccess`, `noEmit`, ESM-only |
| `node.json` | the controller and every package that runs on Node |
| `next.json` | `apps/web` only, adding DOM libs and the Next plugin |

There is no build output anywhere except `packages/runtime/dist`, which is why
`noEmit` is on in the base: `tsc` is a checker here, not a compiler. TypeScript
runs directly through `tsx`.

Loosening a rule in a package's own `tsconfig.json` rather than here should be
rare and should carry a comment saying why.
