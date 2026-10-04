# Cloud provisioning

A chat can create its own cloud environment instead of attaching to one an operator declared ahead of time. E2B gives Linux containers that start in seconds. Namespace gives real Macs running an Xcode image, which is what iOS work needs.

A provisioning manager is a T3 server that owns that lifecycle. It allocates the machine, prepares it, and hands back a pairing URL. The desktop app talks to a manager; it does not talk to E2B directly.

## Configure a machine

Provisioning reads `~/.t3/environment-control.json`. Four things matter:

- `e2bApiKey`, required for anything E2B.
- `provisioning.templateId`, the E2B template new environments fork from, unless their repository has a warm base (below).
- `provisioning.runtimeArtifacts.linux`, the pinned build a new environment runs. Without it provisioning refuses with `unconfigured` rather than failing, because an install that only manages named targets is an ordinary configuration state.
- `provisioning.githubToken`, required only for cloning a private repository.

Clients offer only what a manager can provision. E2B appears when `provisioning.runtimeArtifacts.linux` is set. Namespace Mac appears when both `provisioning.runtimeArtifacts.macos` and `provisioning.namespace` are set.

`provisioning.skills` is optional and names skill bundles copied into every new environment. Each entry has a `source` directory on the manager. Give it a `name` when the source is one skill; omit `name` when the source is a directory of skills, because every supported CLI resolves a skill as `<root>/<directory>/SKILL.md` and looks no deeper.

Skills land in the home directory and follow the selected driver. Codex reads `.codex/skills`, Cursor reads `.cursor/skills`, Claude reads `.claude/skills`. They never land in the checkout, which is what the agent opens a pull request from. An entry's optional `agents` list (`codex`, `cursor`, `claudeAgent`) limits it to those drivers, so a Cursor bundle and a Claude/Codex port of it can share skill names. A manager that runs no agents itself (`T3CODE_LOCAL_AGENT_RUNS=false`) lists these bundles as each driver's skills, so the composer offers what a new environment will have.

A repository whose `e2b` entry sets `warm: true` and has `prepareCommands` gets a warm base after its first cloud chat. The manager builds one cold box on the default branch. It then removes that box's T3 identity, installed files and credential files. A restored box pages its memory in on demand, and a build's full page cache made every restore slow, so the manager drops the page cache and starts the box once more the way a chat would. The snapshot's memory then holds only what a chat's start reads. The manager removes the identity and files again, snapshots the box, and kills it. The prepare commands therefore run twice in a build. Later chats for the repository start from the snapshot. They fetch their own revision into the prepared checkout and rerun the prepare commands. Those commands must therefore be safe to rerun on a tree they already prepared. The base is rebuilt every `provisioning.warmBaseRefreshHours` (default 12, `0` turns warm bases off). It is also rebuilt when the template, the linux runtime artifact, the repository's prepare commands, `egressAllow` or `provisioning.workspaceFiles` change. Until the rebuild lands, chats start cold. A chat that fails to prepare from a base retires it: later chats start cold, and the manager builds a new base after a backoff that doubles with each consecutive failure, up to a day. A repository no chat used for three days keeps no base until its next chat. Anything a prepare command derives from a workspace file, such as a copied `.env`, stays in the snapshot. The seal deletes the whole T3 home (`$HOME/.t3`), so a prepare command that keeps its own state there must cope with finding it gone. Records live under `<state>/provisioning/warm-bases`.

A repository whose `namespace` entry sets `spare: true` and has prepare commands keeps one spare Mac after its first cloud chat. Namespace cannot snapshot or fork a Mac, so the spare is a whole Devbox. The manager builds it like a cold chat on the default branch, removes its T3 identity, installed files and credential files, and stops it. A stopped Devbox keeps its volume and costs only storage. The next chat for the repository claims the spare and owns it from then on. It prepares at the spare's root with its own identity, files and credentials, fetches its revision, and reruns the prepare commands, which must be safe to rerun. A Devbox cannot be renamed, so a claimed spare keeps the name of the build that made it (`t3-<build request>`), not the chat's. The manager then builds the next spare, and a chat that arrives before it lands starts cold. A spare follows a warm base's schedule: it is rebuilt every `provisioning.warmBaseRefreshHours`, and when the Mac size, region, idle timeout, Namespace account, macos runtime artifact, prepare commands, `artifacts` or `provisioning.workspaceFiles` change. A repository no chat used for three days keeps no spare until its next chat. Records live under `<state>/provisioning/spares`, and `claims/` beside them names the chat that took each spare.

A host packed by `pack-host-state.ts` or `deploy-provision-manager.mjs` carries copies of `provisioning.homeFiles` and `provisioning.workspaceFiles`, except agent login files, which the host installs per account. `provisioning.workspaceFiles` land in every checkout; a repository entry's own `workspaceFiles` do not travel. With `githubToken` set, provisioning writes `.gitconfig`, `.git-credentials`, and `.config/gh/hosts.yml` itself, so the packer refuses a home file at any of those paths.

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

A setup-token cannot report which account it belongs to, so the packer records each account's email from its local login (`.claude.json` in the account's config directory, else the `Claude · email` display name) as the instance's `accountEmail`, and the manager hands it to each environment. Limits uses it to show an account once when both the Mac and the manager run it. Limits never reads a cloud machine, since clients do not list them as environments: a machine only runs copies of its manager's accounts, and one provisioned before the manager recorded emails cannot name its Claude account. When several accounts report identical limits, Limits and the manager's log name them: a token was most likely minted from the wrong login. Mint it again from the right config directory and repack.

## Codex accounts

Codex rotates a ChatGPT login's refresh token too, and rejects a reused one, so every copy of one `auth.json` that refreshes signs out all the others. Each login therefore has one owner that refreshes it, and every other copy carries a refresh token that cannot be redeemed ([`stripCodexRefreshToken`](../../apps/server/src/provider/codexLoginCopy.ts)). Such a copy stops working when its access token expires, about ten days after the owner's last refresh.

Give a container host its own login per account, separate from your computer's:

```bash
CODEX_HOME=~/.t3/host-codex/codex_personal codex login --device-auth
```

`pack-host-state.ts` carries `~/.t3/host-codex/<instanceId>/auth.json` whole (`--codex-host-logins` names another directory) and falls back to a copy of your computer's login, logging each account that does. Once the seed is written it renames each carried file to `auth.json.packed-<seed name>`, because the host owns that login from then on. Sign in again before packing that account for a new host. A repack without one carries a copy, which never replaces the host's own login.

Only a server that runs no agents itself (`T3CODE_LOCAL_AGENT_RUNS=false`) refreshes ahead of Codex. Its status probe asks Codex to refresh a login once less than 48 hours are left, checking hourly, and provisioning refreshes a login with less than a day left before copying it into a new environment. Other servers leave refreshing to Codex, since several of them can share one Codex home. If a host's own login is past expiry because its refresh failed, the host reports it as signed out and asks for a new sign-in and a reseed. The host's entrypoint keeps its own login over any seed login that cannot refresh (stripped, undated or unreadable), and a refreshable seed login replaces it only when it is another account's or newer. `deploy-provision-manager.mjs` carries copies only, since one login cannot have two owners.

Provisioning refuses a Codex login it cannot parse, which can happen while Codex is rewriting the file, rather than copy it raw. Routing skips a Codex account whose access token expires within 30 minutes, and a server reports such a copied login as signed out. Re-pack a host to hand it fresh copies. A manager that reads its own logins hands each new environment a copy of whatever it last refreshed.

## Which account a cloud environment uses

The chat picks a provider, not an account. The manager runs each provider on its enabled account with the most usage left per chat over the next five hours, judged by the account's tightest limit window (session, weekly, or monthly) in the manager's last usage refresh. A window that refills within those five hours counts as full for the part after its reset, as long as its room lasts until then, so an account with 5% left that resets in ten minutes beats one with half its week left, and one with 1% left that resets in half an hour does not. A window spent right now still counts as spent, since the first turn would fail. That usage is split among the chats already running on the account: cloud machines using it for any of their agents, from the moment their request is saved until they pause, and local threads with a turn in progress. Instances signed in to the same email, or whose readings match window for window, count as one subscription. Launches route one at a time, so two launches a moment apart split across accounts. A reading counts however old it is, since a window's usage only rises until it resets. The exception is a window that reads spent and reports no reset: after 30 minutes the manager treats that account's usage as unknown, unless another window is still spent. An account with no known usage ranks below accounts with room left but above spent ones, and an account whose login cannot be copied is skipped, so a Claude account without a setup-token never gets picked. A Codex account whose login is about to expire is skipped too. The choice is frozen with the request, so retrying or resuming keeps the same account.

## Stand up a manager

```
node scripts/cloud/deploy-provision-manager.mjs --output /tmp/manager
```

The script builds the runtime artifact, creates a sandbox from the configured template, installs the artifact, starts the server, waits for readiness, and writes `manager.json` with the sandbox ID, host and pinned artifact hash.

Pass `--artifact FILE` to reuse a build. `--auth FILE` points at the account credential to install, and defaults to `~/.codex/auth.json`.

A host that should only provision, such as a small always-on server, runs with `T3CODE_LOCAL_AGENT_RUNS=false`. Clients then leave it out of "Run on", start new chats in its projects on the first cloud kind it offers, and the server refuses to start a turn on its own machine. Its projects and old threads stay browsable.

Namespace needs a manager whose user token file holds a Namespace credential: `~/Library/Application Support/ns/token.json` on macOS, or `$XDG_CONFIG_HOME/ns/token.json` (default `~/.config/ns/token.json`) on Linux. On a Mac, `nsc login` writes it. A container host packed with `pack-host-state.ts --namespace-session` carries that login's 30-day session token, so re-pack it after each `nsc login`. A host packed with `--namespace-federated` carries no credential. It keeps a federated workload token at that path itself and rewrites it atomically well before its hour runs out. The manager rereads the file on every call and refuses a call the token would not outlive. The workspace is whichever tenant the token names; the Namespace settings do not choose one. A federated token has no actor, and Namespace refuses private Macs without one, so its Macs are shared with the workspace: use a workspace only you belong to. `scripts/cloud/local-manager.sh start` runs a manager from your checkout instead. It copies the config from `~/.t3/fork-dev` (set `SOURCE_HOME` to use another home) into `.t3/manager`, pins an artifact built from `HEAD`, serves on `127.0.0.1`, and writes a pairing token to `.t3/manager/pairing-token`. `stop` stops it. Smoke it end to end with:

```
node scripts/cloud/smoke-cloud-chat.ts --origin http://127.0.0.1:$(cat .t3/manager/manager.port) \
  --pairing-token-file .t3/manager/pairing-token --manager-log .t3/manager/manager.log \
  --manager-state .t3/manager/userdata --provider namespace --steps provision,turns,device,resume,delete --report /tmp/run.json
```

`--manager-log` copies the manager's per-phase provisioning timings into the report. `--manager-state` lets each `account.<driver>` check compare the account the box signed in as with the one routing froze for every driver, companions included; without it only the chat's own account is checked against routing. A Claude setup-token carries no email, so that check compares the weekly reset the box sees with the manager's for the same account, which catches a token minted from the wrong login. The `device` step is Namespace-only. It boots a simulator, builds and launches a sample app, takes a screenshot, records a video, and stops at an LLDB breakpoint, then checks the files each step left on the box.

## Run Mac chats on compute instances

A repository whose `provisioning.repositories[].namespace.engine` is `"instance"` runs new Mac chats on per-chat Namespace compute instances instead of Devboxes; the default is `"devbox"`, and a chat keeps the engine it was frozen with. The instance engine mounts a per-repository cache volume at `/Volumes/t3`, prepares every chat at `/Volumes/t3/root`, and keeps a released chat as a snapshot in Namespace artifact storage, so a pause costs nothing on Namespace and a resume can land on any Mac. Namespace ends every Mac five hours after it starts, so the manager saves the chat and lets the Mac go first: a chat idle in the Mac's last 30 minutes sleeps until a client opens it, and one still working 8 minutes before the end moves to a new Mac without waiting for a client, where its interrupted turn continues. After 3 such moves in a row with no client heartbeat or resume, the next deadline puts the chat to sleep instead, and opening it continues the turn. A chat's Mac only reads the cache and is always destroyed without committing it. When a chat finds no current template (none, or one older than 12 hours or from different prepare commands), the manager starts one builder Mac per repository, labelled `t3.builder=<cache tag>`, that prepares the same checkout with no chat on it, seals it as the template and commits the volume. Only a chat frozen under the current prepare commands, artifacts and pinned runtime asks for one, so older chats never replace a newer template. A repository gets at most 3 builds an hour, a failed build backs off from 5 minutes doubling to 2 hours, and the manager abandons builders it left running before a restart. Namespace picks every Mac's site and each site keeps its own volume, so a builder fills only the site it lands in. The manager's chat records live in `<state>/namespace-chats`, and Macs and snapshots carry the label `t3.chat=<requestId>`. A prepare command written as `{ "command": "...", "background": true }` starts a service for the chat rather than preparing the checkout; chats run it as usual and builders skip it. A snapshot leaves out what preparation rebuilds. When a repository's prepare commands install a toolchain into the home, list it in `namespace.derivedHomePaths` (for megpt-mono, `.local/share/megpt-mind-python`, `.local/share/modal-cli` and `.bun/bin`) so its chats' snapshots carry only their own state.

Prove a change to it end to end against a local manager with the engine set in `.t3/manager/environment-control.json`:

```
node apps/server/scripts/mac-chat-e2e.ts --origin http://127.0.0.1:$(cat .t3/manager/manager.port) \
  --pairing-token-file .t3/manager/pairing-token --manager-state .t3/manager/userdata \
  --manager-log .t3/manager/manager.log --repo andrewcai8/t3code --report /tmp/mac-e2e.json
```

It needs `nsc login` on the machine running it, and it disposes what it made and releases the repository's cache volume at the end.

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

## Count a machine's usage on the manager

The manager's Usage page counts its own transcripts and its cloud boxes. A machine no client connects to, such as a laptop you worked on before moving to the manager, can push its history with `apps/server/scripts/import-machine-usage.ts`, run from a checkout on that machine:

```
node apps/server/scripts/import-machine-usage.ts --dry-run
node apps/server/scripts/import-machine-usage.ts --origin https://manager \
  --pairing-token-file <file holding a pairing token>
```

The script scans the provider homes in the machine's `~/.t3/userdata/settings.json` with the server's own scanner, reading that directory only, and replaces what the manager keeps for the machine's environment id. The manager keeps the same 90 days it keeps for boxes, so run the script hourly to keep the page current. Cursor is left out because the manager reads the Cursor account itself. `--remove` deletes the machine's history from the manager.
