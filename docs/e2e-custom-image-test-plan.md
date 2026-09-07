# Custom image end-to-end test plan

This plan verifies that a public repository image is validated, selected for a new session, retained across warm turns, and used again for a cold continuation after checkpoint expiry.

## Test image

The shared test image is `docker.io/baotq4/pi-cloud-agent-e2e:e2e-20260907-multiarch`.

The image digest is `sha256:5f6da95988c33d4a62cb69ea54427e1ddce759db6dfd585323789f2085f813ed` and contains the normal runtime contract plus `tree` and `/etc/pi-cloud-agent/e2e-marker` with the value `custom-image-e2e-20260907`.

Use the tag in Settings so both Apple Silicon/local hosts and x86/E2B hosts can select their native manifest. The image is public because the E2B build service must be able to pull it without private-registry credentials.

## Setup

1. Connect a test repository in the dashboard and open Settings → Repository environments.
2. Select the repository and enter `docker.io/baotq4/pi-cloud-agent-e2e:e2e-20260907-multiarch` in **Container image reference**.
3. Click **Test image** and expect **Image test passed** with no provider-specific wording in the surrounding Settings UI.
4. Click **Save image**, create a new session for the repository, and keep the session id for later assertions.
5. Capture the run event stream and the session detail response for every turn.

## Initial image and session prompt

Send this prompt as the first turn:

```text
Prove that this session started from the configured repository container image. Do not install packages and do not modify files other than the proof file requested below. Run these checks: id -un; node --version; command -v tree; test -r /app/run.js; test -r /app/package.json; test -d /workspace; cat /etc/pi-cloud-agent/e2e-marker. Create image-e2e-proof.txt in the repository containing the exact marker value, the current user, the Node version, and the output of tree --version. Return the same values in your response.
```

Expected result: the run succeeds, the proof file is committed to the session workspace, the marker is `custom-image-e2e-20260907`, the user is `node`, and the event stream contains the normal clone/checkout and agent-start events.

## Warm resume prompt

After the first run is terminal and the session is idle, send this follow-up in the same session:

```text
This is a continuation turn. Read image-e2e-proof.txt and report every value exactly as written. Verify that /etc/pi-cloud-agent/e2e-marker still contains custom-image-e2e-20260907 and that tree is still available. Do not clone the repository, install packages, or rewrite the proof file.
```

Expected result: the proof file and marker are present, the Pi conversation recalls the first-turn values, the session id is unchanged, the provider resumes the stored workspace checkpoint, and the follow-up emits no second `git.cloned` event.

## E2E capability matrix

| Case | Action | Expected behavior and evidence |
|---|---|---|
| Image reference validation | Test the shared image, then test an image that lacks `/app/run.js` or `gh` | The valid image passes; the invalid image fails with bounded compatibility output and is not used successfully for a run. |
| Mapping persistence | Save the image, reload Settings, and switch away and back to the repository | The exact image reference is retained and displayed without mentioning microSandbox or E2B. |
| Initial provisioning | Start a new session with the initial prompt | The selected image is used, the runtime contract passes, and the session records the resolved image pin. |
| Warm resume | Send the warm-resume prompt after a successful turn | The same workspace checkpoint is resumed; files, installed tools, and Pi history remain; no reclone occurs. |
| Checkpoint replacement | Complete two turns that change the proof file, then resume a third turn | The newest proof content is present and the previous checkpoint is reclaimed only after the replacement is durable. |
| Missing checkpoint | Delete or corrupt the provider checkpoint before a follow-up | The stale reference is cleared, the run cold-starts from the pinned repository image, Pi history remains, and the checkout is cloned again. |
| Inactive retention | Set a short workspace retention interval, let the session expire, then send a follow-up | The session becomes inactive, the provider artifact is deleted, and the next turn uses the pinned image with `WORKSPACE_RESUMED=false`. |
| Archive cleanup | Archive an idle session and request it again | The session, runs, Pi checkpoint, and provider artifact are deleted; repeated reads return `404`. |
| Archive race | Submit a follow-up while archive cleanup is in progress | The follow-up receives a conflict response and cannot create a run after the archive operation claims the session. |
| Image pinning | Create a session with image tag A, change the repository mapping to tag B, and force a cold resume | The existing session still uses tag A; a new session uses tag B. |
| Repository isolation | Run two sessions for the same repository and write different proof values | Each session sees only its own workspace checkpoint and cannot read the other session's file. |
| User isolation | Configure the same repository for two users with different public images | Each user sees and provisions only their own mapping and session artifacts. |
| Concurrent follow-ups | Submit multiple messages while one turn is active | Runs are queued in order, only one owns the workspace, and promotion occurs after the active turn parks its checkpoint. |
| Credential hygiene | Inspect the proof file and image layers after a run | No callback, forge, model, or plugin credential value is present in the image or parked workspace. |
| Provider abstraction | Repeat the initial, warm-resume, cold-resume, and archive cases with each deployment provider | User-visible behavior and API contracts are identical; provider-specific materialization stays in operator logs and provider internals. |
| Automatic hosted-image materialization | Point the mapping at a new public OCI tag while using the hosted provider | The app creates or reuses its internal provider artifact automatically, starts the runtime, and does not require the user to create a provider template. |
| Restart recovery | Restart the controller between turns and during checkpoint parking | Reconciliation resumes from durable state without losing the session, duplicating a run, or leaking a sandbox. |

## Evidence checklist

- Settings shows a generic **Container image reference** field and does not require provider knowledge.
- The image preflight response is successful before saving the mapping.
- The first run has one `git.cloned` event and a successful terminal status.
- The warm follow-up has the same session id, the proof file, and no second `git.cloned` event.
- The session detail shows an active checkpoint and a recorded checkpoint size when the provider reports one.
- An expired session shows `inactive`, then cold-starts with the same pinned image and a fresh clone.
- Archive removes the session and its provider artifact.
- Provider logs may show internal image/template materialization, but no provider choice is exposed in Settings.

## Why hosted providers still have an internal template

The hosted provider API creates sandboxes from templates, so the app materializes a deterministic internal template from the public OCI reference and caches it by image reference. This is an implementation detail: users supply one public image reference, and the app builds or reuses the hosted artifact automatically before starting the session runtime.

The template start command remains inert because per-run callback tokens, model settings, plugin configuration, and session paths exist only when a run is created. The app starts the real runtime command after sandbox creation with those run-scoped values.
