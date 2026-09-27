# Automations

An automation runs an agent on a repository without you starting the chat. It pairs a
repository, a prompt, an agent, and a cloud machine (E2B or a Mac). It runs on a schedule, when
its webhook link is called, or when you choose **Run now**. Each run opens a normal chat that
shows in the sidebar of the web and desktop apps connected to that host. The mobile app does not
support automations yet.

## Create an automation

Choose **Automations** at the top of the sidebar, or **Open automations** in the command palette,
then **New automation**. Automations need a connected host with cloud environments configured.
Other hosts do not offer them.

- **Repository** lists the repositories of the projects you have added to T3 Code. To use another
  repository, type its `owner/name`. **Branch** defaults to the repository's default branch.
- **Prompt** is the first message of every run's chat. The template buttons fill in a starter
  prompt.
- **Agent** is Codex, Claude, or Cursor, whichever the host has set up. **Account** defaults to
  **Most usage left**, which picks the account with the most usage remaining when each run starts.
  Choose an account to always use that one. **Model** defaults to the agent's default model.
- **Runs on** is E2B or Mac.
- Turn an automation off from its card, or with **On** in the editor, to pause it without
  deleting it.

Prompts can invoke skills such as `/poteto-mode`. The machines have `gh` with push access to the
repository, so a prompt can ask the agent to open a pull request.

## Run on a schedule

Turn on **Schedule** and pick every hour, every day, weekdays, or every week, then the time. The
editor lists the next few runs in your local time. For anything else, pick **Custom cron** and
enter a five-field cron expression, such as `0 9 1 * *` for 9:00 on the first of each month. The
schedule is read in the time zone shown, which defaults to this device's and takes an IANA name
such as `America/New_York`. Runs must be at least 15 minutes apart, so a schedule such as
`*/5 * * * *` is not accepted.

## Run from a webhook

Turn on **Webhook** and save. T3 Code shows the link once. Copy it
then, because it is not shown again. Anyone with the link can start runs.

Send a `POST` request to the link to start a run:

```bash
curl -X POST "$AUTOMATION_LINK" -H "Content-Type: application/json" -d '{"issue": 142}'
```

The request body is added to the prompt as context. JSON and plain text both work, and only about
the first 16 KB is used. Bodies over 64 KB are refused with `413`. Each automation accepts 20 webhook runs per hour. Calls beyond that
return `429`.

If the link leaks, choose **Rotate webhook link** from the automation's menu. The old link stops
working and the new one is shown once.

The link uses the address your client uses to reach the host. A link with a local address such as
`127.0.0.1` only works on that machine. To call it from another service, open Automations from a
client connected through the host's network or tunnel address, such as
[T3 Connect or Tailscale](./remote-access.md). If your client does not know the host's web
address, it shows the link's path instead. Put the host's address in front of it.

## Follow runs

Each automation's card shows its next run, how its last run went, and its recent runs with what
started them, when, and how far they got. **Open chat** connects to the run's machine, waking it if it is paused, and opens its chat.

A run that fails to start shows its error, and its machine is cleaned up. A run that is triggered
while the previous one is still starting is skipped, and the history shows it as **Skipped** with
the reason.

While the web or desktop app is open and visible, it checks the host about once a minute and adds
the chats of up to 10 of the newest runs started in the last 24 hours to the sidebar. A run's
machine pauses when idle until you open its chat, after which it stays awake while the app is open.
A run's chat you never opened leaves the sidebar once its machine pauses or it is no longer among
the 10 newest; open it from the run history instead. If you remove a run's environment from your
sidebar, it stays removed.

Each run's machine, and the chat on it, is removed 24 hours after the run started. Work the agent
pushed, such as a branch or a pull request, stays on GitHub.
