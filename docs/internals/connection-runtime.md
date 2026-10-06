# Connection runtime

Web, the desktop renderer, and mobile share one connection owner per environment
in `packages/client-runtime`. Platform code supplies storage, credentials, network
signals, and application lifecycle events. React views consume the runtime.
Keeping retries and session lifetime here prevents competing reconnect loops when
several views need the same environment.

## One transport retry owner

The [supervisor](../../packages/client-runtime/src/connection/supervisor.ts) owns
transport retry policy; resolving an endpoint and opening an RPC session are single
attempts. Transient failures retry with jittered exponential backoff, capped at
five minutes, that resets only after a connection stays up. Without jitter, every
client of a restarted server reconnects in the same second; with a short cap, a
client that can never connect retries all day. Offline states and authentication
failures wait for a wakeup instead of spending attempts on unchanged conditions.

Foregrounding, an explicit retry, and an offline report probe the established
session, and only a failed probe reconnects. Offline reports are often wrong, for
example for a loopback server. A long mobile background suspension is the one
exception: it replaces the session at once, because the OS can kill a socket
without reporting closure, and a probe would hold a dead socket in "Resuming"
until it times out. That fresh attempt runs even while the network reports
offline. Foregrounding also wakes a pending retry immediately and
leaves an ordinary in-flight attempt alone.

The [registry](../../packages/client-runtime/src/connection/registry.ts) scopes
connections by environment. An involuntary disconnect retains the registration
and cached data. Explicit removal closes the scope and clears credentials,
projections, and platform-owned state such as drafts. Cloud-account changes apply
to relay registrations; they must not discard directly paired environments.

## Cloud boxes belong to their chats

A box's host is the source of truth for which cloud chats exist. Every client
follows each connected host's list of its boxes into its own catalog
(`syncHostBoxes` in the
[registry](../../packages/client-runtime/src/connection/registry.ts), planned by
[`planHostBoxSync`](../../packages/client-runtime/src/connection/hostBoxSync.ts)).
A chat box this device never opened is saved without a pairing, and its shell
cache is seeded from the host's last read of the chat, so the chat lists on
every device without dialing the box, and a paused box stays paused. Unpaired
means the entry has no profile; it is never a separate flag, and only a box may
be saved without a credential. A gone box this device never paired is forgotten
with its cache; one it paired stays as a missing workspace so its history reads.

A box is saved like any paired server, so its credential and cached chat survive
a restart, but its target carries the host that provisioned it
(`BearerConnectionTarget.box`). That mark decides two things once, instead of
each surface filtering boxes out. Environment lists, from
[`presentationsAtom`](../../packages/client-runtime/src/state/presentation.ts) and
`userEnvironmentIds`, leave boxes out, so no picker, grouping, or settings list
can offer one. The registry connects a box only while something
[demands](../../packages/client-runtime/src/connection/registry.ts) it: its open
chat, the draft that is provisioning it, or a turn running on it that its host
still lists active and this device has paired. Read a box's own state through
the point atoms.

Opening an unpaired box pairs it inside the box's own dial, not in a view. The
registry's box driver attaches through the host,
[redeems the pairing](../../packages/client-runtime/src/connection/boxPairing.ts)
where this client can reach it, and saves it into the entry in place, so the same
attempt connects with it and no replacement supervisor pairs again. A loopback
pairing (Namespace) is redeemed through the host's gateway at the address this
client already dials the host by. Pairing runs only while the entry has no
pairing, so a device pairs a box at most once. Later dials, reopens and reloads
find it saved, and a creating join skips a box it already holds a
pairing for. Every pairing opens a session on the box, so pairing again on each
open would pile them up.

A paused box's address still answers, with a gateway 404, 502 or 503 that the
resolver reads as `not-serving`, and an unpaired box's dial fails the same
way when its host lists it paused or the host's attach refuses it as not serving.
The supervisor wakes it, not a view: after such
a dial it enters `waking`, the registry asks the box's host to resume it, and the
supervisor dials again. `waking` means a resume is in flight to a connected
host; while the host is down the box backs off and redials instead, and a
resume the host never answered is sent again on the next dial. A box the host
did answer for but that stays down is woken again after 30 seconds, then at
doubling intervals up to every 10 minutes, for as long as it is demanded.
Reopening its chat or a retry starts that interval over. A view that woke boxes
fired once per cached host list, so a failed resume or a box paused under its
open chat stayed down.

While a box is connected and its user is here, the registry renews its lease
through its host, so every client with the chat open keeps the box awake, not
only the one that started it. Without that, the host pauses the box under a
phone's or a second tab's open chat and the wake brings it back, a Mac boot
every cycle. The host still requires an operate session and an active, claimed
lease to renew one.

While its user is here, a client also reports presence to each host it holds
boxes of, every four minutes and at once when the user returns. The host then
wakes the boxes of every unsettled chat and renews them until the reports stop,
after which they idle out as usual. The host decides, not the client, because
only it sees every client's reports and the account's Mac count, and waking a
box this way opens no connection to it. The answer names each box that is
asleep, waking or updating, and why and when its provider last could not start
it, which is what lists and banners show for a cloud chat. That failure lives on
the host because every client's wake and the host's own join one resume there.
It is reported only while a wake is in flight or the host would still retry the
box, and for no longer than the longest backoff, so a label never outlives the
retries. The client asks again every 15 seconds while a box is changing or its
provider keeps failing. A refusal for that reason skips the
upgrade a refused resume otherwise tries, since there is no guest to upgrade.

"Here" is `UserPresence`: the app is visible (foreground on mobile) and the
user touched it within the hour. Each surface reports visibility and input; the
rule lives in client-runtime. A box is woken only while its user is here too,
and their return retries every box that is down. An open connection alone does
not keep a Mac running, so a forgotten tab lets its box idle out. The host
never pauses a box whose agent is busy, whatever the clients do.

Boxes saved before the mark existed are marked from this device's lease records
and from their host's list, which also renames each box after its chat's
repository and machine. A box paired from a bare link stays an ordinary
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
