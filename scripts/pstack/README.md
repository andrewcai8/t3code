# pstack build

`build.sh` builds the pstack this fork's cloud environments use: [chhoumann/t3-pstack](https://github.com/chhoumann/t3-pstack) at a release, flattened from its Claude Code and Codex plugin into plain skill directories. t3-pstack is cursor/plugins `pstack` with its Cursor mechanics rewritten for T3 (`delegate_task` panels across providers, `schedule_task`, `watch_pull_request`), and it carries its own upstream sync. Claude and Codex read the same skills.

The `pstack-skills` workflow runs it daily against t3-pstack's newest `v*` tag, never its `main`, and replaces the archives on the `pstack-skills` release. A host whose `provisioning.skills` entries name those archives as `url` follows them ([cloud provisioning](../../docs/operations/cloud-provisioning.md)). Both archive names carry the same skills.

Flattening drops the plugin's hooks and manifests. Two plugin-root files move into skills: the agent briefs into `poteto-mode/agents/` and `models.json` beside `setup-pstack`, with the references that name them rewritten. The build fails, and the workflow keeps the last good build, when a skill names a `<plugin root>/` file or a script reads a relative path the flattened tree lacks.

Roles read their models from `~/.config/t3-pstack/models.md`, entries such as `claudeAgent/claude-opus-5-5 effort=xhigh`. Without one, each role takes its skill's default, and the default panels include `grok`. Write the sheet with `/setup-pstack` and carry it to boxes as a `provisioning.homeFiles` entry.
