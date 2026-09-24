# Cloud provisioning

A chat can create its own cloud environment instead of attaching to one an operator declared ahead of time. E2B gives Linux containers that start in seconds. Namespace gives real Macs running an Xcode image, which is what iOS work needs.

A provisioning manager is a T3 server that owns that lifecycle. It allocates the machine, prepares it, and hands back a pairing URL. The desktop app talks to a manager; it does not talk to E2B directly.

## Configure a machine

Provisioning reads `~/.t3/environment-control.json`. Four things matter:

- `e2bApiKey`, required for anything E2B.
- `provisioning.templateId`, the E2B template new environments fork from.
- `provisioning.runtimeArtifacts.linux`, the pinned build a new environment runs. Without it provisioning refuses with `unconfigured` rather than failing, because an install that only manages named targets is an ordinary configuration state.
- `provisioning.githubToken`, required only for cloning a private repository.

Clients offer only what a manager can provision. E2B appears when `provisioning.runtimeArtifacts.linux` is set. Namespace Mac appears when both `provisioning.runtimeArtifacts.macos` and `provisioning.namespace` are set.

`provisioning.skills` is optional and names skill bundles copied into every new environment. Each entry has a `source` directory on the manager. Give it a `name` when the source is one skill; omit `name` when the source is a directory of skills, because every supported CLI resolves a skill as `<root>/<directory>/SKILL.md` and looks no deeper.

Skills land in the home directory and follow the selected driver. Codex reads `.codex/skills`, Cursor reads `.cursor/skills`, Claude reads `.claude/skills`. They never land in the checkout, which is what the agent opens a pull request from.

## Sign in Claude accounts

A Claude account on macOS keeps its login in the keychain, and that login cannot be copied. Claude Code rotates its refresh token, so two machines sharing one login fork the chain and one of them is signed out. Give each Claude account a setup-token for cloud use instead:

```bash
CLAUDE_CONFIG_DIR=~/.claude_personal claude setup-token
```

Use the account's config directory, or drop `CLAUDE_CONFIG_DIR=` for the default account. Put the printed token under `provisioning.claudeOAuthTokens`, keyed by the provider instance id:

```json
{ "provisioning": { "claudeOAuthTokens": { "claude_personal": "sk-ant-oat01-..." } } }
```

Cloud environments for that account receive it as `CLAUDE_CODE_OAUTH_TOKEN`. A manager deployed by `deploy-provision-manager.mjs` or `pack-host-state.ts` runs that account on the token too, so the manager can chat on it and read its usage. Local runs keep using the keychain login. A credential set in the instance's own environment variables still wins, and an account with a `.credentials.json` file needs no token.

## Which account a cloud environment uses

The chat picks a provider, not an account. The manager runs each provider on its enabled account with the most usage left per chat, judged by the account's tightest limit window (session, weekly, or monthly) in the manager's last usage refresh, split among the chats already running on it: awake cloud machines using that account for any of their agents and local threads with a turn in progress. An account with no known usage ranks last, and an account whose login cannot be copied is skipped, so a Claude account without a setup-token never gets picked. The choice is frozen with the request, so retrying or resuming keeps the same account.

## Stand up a manager

```
node scripts/cloud/deploy-provision-manager.mjs --output /tmp/manager
```

The script builds the runtime artifact, creates a sandbox from the configured template, installs the artifact, starts the server, waits for readiness, and writes `manager.json` with the sandbox ID, host and pinned artifact hash.

Pass `--artifact FILE` to reuse a build. `--auth FILE` points at the account credential to install, and defaults to `~/.codex/auth.json`.

## Why the manager runs the artifact

The E2B template ships the published `t3` package from npm. That is upstream's build. It does not contain this fork's provisioning code, and the version number matches, so the mismatch is invisible until the server fails to start.

A manager must therefore run the runtime artifact, never the template's `t3`. Child environments already do this: their readiness payload points `runtimeEntrypoint` at the extracted artifact. The deploy script does the same for the manager.

## Packaging skill bundles on macOS

`tar` on macOS writes an AppleDouble `._name` sidecar for every entry carrying extended attributes. The sidecars are invisible locally and arrive as junk in the sandbox, turning a 122-file bundle into 307 files. `COPYFILE_DISABLE=1` suppresses them. `tar --no-xattrs` alone does not. The deploy script sets the variable; anything else that packages a bundle has to as well.

## Check a provisioned environment

Read the skill root from the child rather than trusting the manager's response:

```
ls <preparationRoot>/home/.codex/skills
```

`.codex/skills/.system` is Codex's own built-in skills, shipped in the template. `ls` hides it because it starts with a dot, so compare counts with `find` and expect that baseline on top of your bundle.
