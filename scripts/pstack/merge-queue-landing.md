**Merge queue first.** Before step 1, run `<plugin root>/skills/poteto-mode/scripts/github-merge-queue-label.sh` in the repository. If it fails, stop and report it: never fall back to `gh pr merge` without knowing the repository has no queue. When it prints a label, that label is how every PR in this repository lands, and it overrides the merge commands in the steps below:

- Enqueue with `gh pr edit <pr> --add-label <label>`. Do not run `gh pr merge` or `origin pr merge`, and do not arm `--auto`.
- Enqueue as soon as the PR's verdict covers its current head. Do not wait for CI or reviews, because the label means merge when ready. Retarget the PR to trunk if needed, but do not rebase it, because the queue rebases.
- A merged PR reads `mergedAt` set or `state` `MERGED`. A labeled PR that is still open is queued, not landed.
- `gt` stays orchestrate-only and is never the land path.

When the label is `trunk-merge-queue-submit`, the queue is Trunk:

- After labeling, trunk-io[bot] adds `trunk-not-ready` (waiting on required checks), then `trunk-queued`, `trunk-testing` and `trunk-tests-passed`, and ends with `trunk-merged`. The submit label alone proves nothing, so report the PR as queued only once a `trunk-` status label appears.
- `trunk-failed` or `trunk-cancelled` means the PR left the queue. Fix the branch, then remove and re-add the submit label.
- Trunk only queues PRs that target trunk, so land a stack bottom-up and retarget each PR once the one below it merges.
- To hold a queued PR, comment `/trunk cancel` or remove the submit label.

When the label is `graphite` or `merge-queue`, the queue is Graphite:

- Read the labels again a few seconds later. If the label is gone, Graphite rejected the GitHub actor, so stop and report it instead of merging around the queue.
- Graphite copies the label onto downstack PRs, so label only the bottom PR. Leave any `[Graphite MQ]` draft PR alone. A label that disappears later is a dequeue, so fix the branch before you enqueue it again.
- Removing the label does not take a PR out of a queue it already joined. To hold one, dequeue it in Graphite.

When the script prints nothing, the repository has no merge queue, so follow the steps below as written.
