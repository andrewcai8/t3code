# Connection runtime

Web, the desktop renderer, and mobile share one connection owner per environment
in `packages/client-runtime`. Platform code supplies storage, credentials, network
signals, and application lifecycle events. React views consume the runtime.
Keeping retries and session lifetime here prevents competing reconnect loops when
several views need the same environment.

## One transport retry owner

The [supervisor](../../packages/client-runtime/src/connection/supervisor.ts) owns
transport retry policy; resolving an endpoint and opening an RPC session are single
attempts. Transient failures retry with capped backoff. Offline states and
authentication failures wait for a wakeup instead of spending attempts on
unchanged conditions.

Foregrounding needs different treatment depending on the connection's state.
It wakes a retry immediately, leaves an ordinary in-flight attempt alone, and
probes an established session before replacing it. A long mobile background
suspension forces replacement because the OS can kill a socket without reporting
closure. Treating every foreground event as a reconnect delays healthy attempts;
treating every resume as harmless leaves suspended sockets stuck.

The [registry](../../packages/client-runtime/src/connection/registry.ts) scopes
connections by environment. An involuntary disconnect retains the registration
and cached data. Explicit removal closes the scope and clears credentials,
projections, and platform-owned state such as drafts. Cloud-account changes apply
to relay registrations; they must not discard directly paired environments.

## Cloud boxes belong to their chats

A cloud box is saved like any paired server, so its credential and cached chat
survive a restart, but its target carries the host that provisioned it
(`BearerConnectionTarget.box`). That mark decides two things once, instead of
each surface filtering boxes out. Environment lists, from
[`presentationsAtom`](../../packages/client-runtime/src/state/presentation.ts) and
`userEnvironmentIds`, leave boxes out, so no picker, grouping, or settings list
can offer one. The registry connects a box only while something
[demands](../../packages/client-runtime/src/connection/registry.ts) it: its open
chat, the draft that is provisioning it, or a turn running on it that its host
still lists active. Read a box's own state through the point atoms.

A paused box's address still answers, with a gateway 404, 502 or 503 that the
resolver reads as `not-serving`. The supervisor wakes it, not a view: after such
a dial it enters `waking`, the registry asks the box's host to resume it, and the
supervisor dials again. A box that stays down is woken again after 30 seconds,
then at doubling intervals up to every 10 minutes, for as long as it is
demanded. A view that woke boxes fired once per cached host list, so a failed
resume or a box paused under its open chat stayed down.

While a box is connected and its user is here, the registry renews its lease
through its host, so every client with the chat open keeps the box awake, not
only the one that started it. Without that, the host pauses the box under a
phone's or a second tab's open chat and the wake brings it back, a Mac boot
every cycle. The host still requires an operate session and an active, claimed
lease to renew one.

"Here" is `UserPresence`: the app is visible (foreground on mobile) and the
user touched it within the hour. Each surface reports visibility and input; the
rule lives in client-runtime. A box is woken only while its user is here too,
and their return retries every box that is down. An open connection alone does
not keep a Mac running, so a forgotten tab lets its box idle out. The host
never pauses a box whose agent is busy, whatever the clients do.

Boxes saved before the mark existed are marked from this device's lease records
and from the lists hosts report. A box paired from a bare link stays an ordinary
environment until its host lists it.

## HTTP authorization

RPC sessions authenticate at socket upgrade, while HTTP requests need current
credentials from the
[authorization service](../../packages/client-runtime/src/authorization/service.ts).
Replacing a healthy socket for HTTP renewal would interrupt conversations and
change the transport generation without a transport failure. Credential expiry
does not close the socket, and refresh failure belongs to the HTTP operation.

Session listings must retain unrevoked connected sessions after credential expiry
so an open connection does not disappear from connection management. This does
not extend the credential's lifetime. New HTTP requests and socket upgrades still
require valid credentials.

## Transport health and data freshness are separate

A socket opening is insufficient evidence that the environment is usable. The
[RPC session](../../packages/client-runtime/src/rpc/session.ts) waits for the
initial server configuration before becoming ready. Shell and thread data then
have their own synchronization state. A failed shell subscription can coexist
with a healthy connection; labeling that state "reconnecting" promises a
transport retry that will never happen.

Cached projections remain readable offline. They must neither imply a live
connection nor overwrite newer live data during a reconnect. Loading and
resuming snapshots belongs to the shared state services, so every view agrees
on which data is current.

[Thread detail](../../packages/client-runtime/src/state/threads.ts) separates
subscription lifetime from cache lifetime. Mounted consumers share one live
stream, which stops when the last consumer unmounts; hidden mounted routes still
count. A registry-local cache retains state and its replay cursor for five idle
minutes so back navigation can resume without another snapshot download.

The desktop app adds one consumer: a
[keep-alive](../../apps/web/src/state/threads.ts) mounts every thread whose
session is starting or running, in each enabled environment. Opening a running
thread then needs no replay. The shell and detail streams are independent, so
the shell can report a stop before the detail loads or catches up. A stopped
thread stays mounted until its own stream is live and shows the stop, and the
stream then closes and saves the settled state.
Web and mobile do not keep threads alive.

Retain state and cursor together only after an update finishes. Cancellation must
not advance the cached cursor beyond the applied data, and an old scope must not
overwrite its successor's cache. Preserve pagination data on reuse, but clear
canceled loading state.

The [RPC boundary](../../packages/client-runtime/src/rpc/client.ts) resolves
requests against the current session at execution time. Durable subscriptions
follow replacement sessions. After a transport failure they wait for the
supervisor; an expected domain failure may resubscribe on the same healthy
session. Reconnection does not automatically replay mutations, whose retry and
idempotency rules belong to the operation.
