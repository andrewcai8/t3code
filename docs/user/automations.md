# Automations

An automation runs an agent on a repository without you starting the chat. It pairs a
repository, a prompt, an agent, and a cloud machine (E2B or a Mac). It runs on a schedule, when
its webhook link is called, or when you choose **Run now**. Each run opens a normal chat that
shows in the sidebar of the web and desktop apps connected to that host.

## Create an automation

Open **Settings → Automations** and choose **New automation**. The page needs a connected host
that is set up for cloud chats.

- **Repository** is `owner/name`. Leave **Branch** empty to use the default branch.
- **Prompt** is the first message of every run's chat.
- **Agent** is Codex, Claude, or Cursor, whichever the host has set up. **Account** defaults to
  **Most usage left**, which picks the account with the most usage remaining when each run starts.
  Choose an account to always use that one.
- **Runs on** is E2B or Mac.
- Turn **On** off to pause the automation without deleting it.

Prompts can invoke skills such as `/poteto-mode`. The machines have `gh` with push access to the
repository, so a prompt can ask the agent to open a pull request.

## Run on a schedule

Turn on **Run on a schedule** and enter a five-field cron expression and an IANA time zone, such as
`America/New_York`. The time zone defaults to this device's. For example, `0 9 * * 1-5` runs at
9:00 on weekdays. The smallest unit is a minute.

## Run from a webhook

Turn on **Run when the webhook link is called** and save. T3 Code shows the link once. Copy it
then, because it is not shown again. Anyone with the link can start runs.

Send a `POST` request to the link to start a run:

```bash
curl -X POST "$AUTOMATION_LINK" -H "Content-Type: application/json" -d '{"issue": 142}'
```

The request body is added to the prompt as context. JSON and plain text both work, and only about
the first 16 KB is used. Each automation accepts 20 webhook runs per hour. Calls beyond that
return `429`.

If the link leaks, choose **Rotate webhook link** from the automation's menu. The old link stops
working and the new one is shown once.

The link uses the address your client uses to reach the host. A link with a local address such as
`127.0.0.1` only works on that machine. To call it from another service, open Settings from a
client connected through the host's network or tunnel address, such as
[T3 Connect or Tailscale](./remote-access.md).

## Follow runs

Each automation lists its recent runs with what started them, when, and how far they got. A failed
run shows its error. **Open chat** goes to the run's chat. Web and desktop apps connected to the
host add new run chats to the sidebar within about a minute. If you remove a run's environment
from your sidebar, it stays removed.
