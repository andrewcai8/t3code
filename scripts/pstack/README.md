# pstack build

`build.sh` builds the pstack this fork's cloud environments and the maintainer's Mac use: cursor/plugins `pstack` at a revision with `overlay.patch` applied, plus its Codex port (`build-codex.py`, `codex-extras/`). The overlay carries the Graphite merge-queue land path, renames the `poteto-mode` skill to its directory name so clients list one `/poteto-mode`, and points `poteto-agent` at the Mac's skill path.

The `pstack-skills` workflow runs it daily and replaces the archives on the `pstack-skills` release. A host whose `provisioning.skills` entries name those archives as `url` follows them ([cloud provisioning](../../docs/operations/cloud-provisioning.md)).

## When the overlay stops applying

The workflow and the Mac's `update.sh` both fail and keep the last good build. Rebase the patch onto upstream, keeping upstream's text and only the overlay's intent:

```sh
git -C <cursor-plugins clone> fetch origin main
git -C <cursor-plugins clone> worktree add --detach /tmp/pstack-rebase origin/main
git -C /tmp/pstack-rebase apply --3way "$PWD/scripts/pstack/overlay.patch"
# resolve the conflict markers, then
git -C /tmp/pstack-rebase add -A
git -C /tmp/pstack-rebase diff --cached -- pstack > scripts/pstack/overlay.patch
git -C <cursor-plugins clone> worktree remove --force /tmp/pstack-rebase
```
