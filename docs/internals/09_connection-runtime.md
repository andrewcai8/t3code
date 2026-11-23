# Connection runtime

Web, desktop, and mobile share one connection owner per environment in `packages/client-runtime`.
Platform code supplies storage, credentials, network signals, and lifecycle events; React views
consume the runtime. Keeping retry and session ownership here prevents competing reconnect loops.

## One transport retry owner

- The [supervisor](../../packages/client-runtime/src/connection/supervisor.ts) is the sole owner of
  transport retries. Endpoint resolution and opening an RPC session are single attempts. Transient
  failures use jittered, capped exponential backoff that resets only after a connection stays up;
  offline and auth failures wait for an explicit wakeup.
- Foregrounding, network changes, explicit retries, and offline reports probe the established
  session rather than blindly reconnecting (OS offline reports are often wrong, especially for
  loopback). Only a failed probe replaces the socket.
- The [registry](../../packages/client-runtime/src/connection/registry.ts) scopes connections by
  environment. An involuntary disconnect keeps the registration and cached projections; explicit
  removal closes the scope and clears credentials, caches, and drafts. Cloud-account changes apply
  only to relay registrations and must never discard directly paired environments.

## HTTP authorization vs. socket lifetime

RPC sockets authenticate at upgrade, while HTTP requests pull current credentials from the
[authorization service](../../packages/client-runtime/src/authorization/service.ts). Never tear down
a healthy socket because an HTTP refresh failed—renewal failure belongs to the HTTP operation. Live
sockets whose access token nears expiry renew in place on the same session so open conversations are
not interrupted. Session listings retain unrevoked connected sessions after credential expiry so
active connections stay manageable without extending the credential's lifetime.

## Transport health and data freshness are separate

- An open socket does not mean the environment is usable. The RPC session waits for initial server
  configuration, and shell and thread subscriptions maintain their own sync state. Never label a
  failed subscription "reconnecting" when the transport is healthy.
- Cached projections stay readable offline, but must never imply a live connection or overwrite
  newer live data on reconnect.
- **Shell snapshots are intentionally partial.** Servers omit idle subagent children and older
  settled threads on demand; left-out rows load via thread-family, shelf, and search queries. A
  missing shell row therefore never proves a thread is deleted—code that deletes data or worktrees
  on absence must verify with the family or server first.

## Subscriptions, caching, and mutations

- [Thread detail](../../packages/client-runtime/src/state/threads.ts) separates subscription
  lifetime from cache lifetime: mounted consumers share one live stream (stopping when the last
  unmounts), while a short-lived cache retains state and its replay cursor for fast back navigation.
- Commit cached state and replay cursor together only after an update completes. Cancellation must
  not advance the cursor past applied data, and an old scope must not overwrite a newer scope's
  cache.
- Durable subscriptions follow replacement sessions automatically. Reconnection never auto-replays
  mutations—retry and idempotency belong to each operation.

## Cloud boxes belong to their chats (fork)

- A box's host is the source of truth for which cloud chats exist. Every client follows each
  connected host's box list into its catalog (`syncHostBoxes` in the
  [registry](../../packages/client-runtime/src/connection/registry.ts), planned by
  [`planHostBoxSync`](../../packages/client-runtime/src/connection/hostBoxSync.ts)). A box this
  device never opened is saved without a pairing and seeded from the host's last read of the chat,
  so it lists everywhere without dialing the box and a paused box stays paused. Unpaired means the
  entry has no profile; only a box may be saved without a credential.
- A box's target carries the host that provisioned it (`BearerConnectionTarget.box`). That mark
  keeps boxes out of every environment list (`presentationsAtom`, `userEnvironmentIds`), and the
  registry connects a box only while something demands it: its open chat, the draft provisioning
  it, or a turn its host still lists active that this device has paired.
- Opening an unpaired box pairs it inside the box's own dial
  ([boxPairing](../../packages/client-runtime/src/connection/boxPairing.ts)) and saves the pairing
  in place, so a device pairs a box at most once. Every pairing opens a session on the box, so
  pairing again on each open would pile them up.
- A paused box's gateway answers 404, 502 or 503, which the resolver reads as `not-serving`. The
  supervisor, not a view, then enters `waking` and asks the host to resume it, retrying after 30 s
  and doubling up to every 10 minutes while the box is demanded.
- While a box is connected and its user is here (`UserPresence`: visible, touched within the
  hour), the registry renews its lease through the host, and the client reports presence to each
  host every four minutes. The host decides which boxes to wake and keep, since only it sees every
  client's reports; it never pauses a box whose agent is busy. An open connection alone does not
  keep a Mac running.
