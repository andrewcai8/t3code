# Pstack on Codex

This plugin contains the official Cursor pstack skills with Codex adapters. Apply these mappings when a skill assumes Cursor or Claude Code.

- Read `~/.codex/pstack-models.md` for model choices. Existing user and project instructions override every bundled model default. Use `gpt-6-astra` for ordinary work. Panel perspectives use `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna` where available. Follow the project's council runner when its instructions require one.
- File reads and shell commands use the available execution tool. File searches use `rg`. Edits use `apply_patch`. Web lookups use the available web tool.
- Skill invocation means reading the named installed `SKILL.md` and following it. `create-skill` and `plugin-dev:skill-development` map to Codex's `skill-creator` skill.
- `Task`, `Agent`, and custom subagent types map to the available collaboration tools. For `poteto-agent`, point the agent to this plugin's `agents/poteto-agent.md`; for `Comment Sicko`, use `agents/comment-sicko.md`. Both paths are relative to the plugin root. Use `spawn_agent`, `send_message`, `followup_task`, and `wait_agent` when available. Follow their actual schemas and the session's delegation restrictions. Do not invent missing flags or tools. If delegation is unavailable, perform the work sequentially and state the limitation when it affects the result.
- Codex agents share the local filesystem. Isolate concurrent writers with separate worktrees or non-overlapping files. Cursor cloud agents and their remote machines have no automatic Codex equivalent.
- `AskQuestion` and `AskUserQuestion` map to the available user-input tool when appropriate, or a concise question. Preserve the user's existing authorization. Task lists use the session's planning tool if available, otherwise a written checklist.
- `run`, `verify`, `browser-use`, and `computer-use` mean driving the actual app with the execution or browser tools available in this session. `ReadLints` means running the project's lint command. Do not claim observations from a tool that is unavailable.
- `/loop` has no assumed built-in equivalent. Use available wait tools or an explicitly requested scheduled task. A local shell loop alone cannot resume a finished conversation.
- Resolve `pstack/skills/...` from the installed plugin root, not the user's repository. Resolve playbook references beside this skill. Commands that use `git show` to recover a playbook from the project's trunk must instead read the pinned installed playbook unless the project actually vendors that path.
- `/setup-pstack` updates `~/.codex/pstack-models.md` and the matching preference section in `~/.codex/AGENTS.md`. Codex does not load Cursor `.mdc` rules or support an `@` include for these preferences. Preserve the user's current role choices unless asked to change them.
- New project skills belong in `.agents/skills/` unless the project specifies another location. Instructions belong in `AGENTS.md`, not `CLAUDE.md`. Existing project paths remain authoritative.
- `make-bot-ui` and any other skill that depends on a particular connected app require that app's available tools. Check available capabilities before promising that workflow.

The supplementary skills retained from pstack-claude may mention Claude tool names. The same mappings apply. Scripts remain bundled with their relative imports and assets. Inspect their runtime-specific assumptions before running them; do not redirect a transcript reader to a different format by guessing a path.
