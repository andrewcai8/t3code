# pstack build

`build.sh` builds the pstack this fork's cloud environments use: [chhoumann/t3-pstack](https://github.com/chhoumann/t3-pstack) at a release, flattened from its Claude Code and Codex plugin into plain skill directories. t3-pstack is cursor/plugins `pstack` with its Cursor mechanics rewritten for T3 (`delegate_task` panels across providers, `schedule_task`, `watch_pull_request`), and it carries its own upstream sync. Claude and Codex read the same skills.

The `pstack-skills` workflow runs it daily against t3-pstack's newest `v*` tag, never its `main`, and replaces the archives on the `pstack-skills` release. A host whose `provisioning.skills` entries name those archives as `url` follows them ([cloud provisioning](../../docs/operations/cloud-provisioning.md)). Both archive names carry the same skills.

Flattening drops the plugin's hooks and manifests. Two plugin-root files move into skills: the agent briefs into `poteto-mode/agents/` and `models.json` beside `setup-pstack`, with the references that name them rewritten. The build fails, and the workflow keeps the last good build, when a skill names a `<plugin root>/` file or a script reads a relative path the flattened tree lacks.

Neither cursor/plugins nor t3-pstack lands through a Graphite merge queue, so the build puts `graphite-landing.md` above the first step of poteto-mode's Shipping playbook and ships `github-merge-queue-label.sh` beside it. A repository with a `graphite` or `merge-queue` label then lands by labeling, not `gh pr merge`. The rule goes in at the step list instead of patching the playbook's prose, because the overlay patch this replaced stopped applying whenever upstream reworded a step.

`models.json` here holds the fork's model tiers. The build writes them over t3-pstack's and runs t3-pstack's generator, which restamps each skill's default models. Every role defaults to Claude Opus 5.5. The review panels (arena, architect, interrogate) add one GPT seat, because t3-pstack rejects a panel drawn from one model family. A `~/.config/t3-pstack/models.md` sheet on a machine still overrides any role.
