**Graphite merge queue first.** Before step 1, run `<plugin root>/skills/poteto-mode/scripts/github-merge-queue-label.sh` in the repository. When it prints a label, that label is how every PR in this repository lands, and it overrides the merge commands in the steps below:

- Enqueue the bottom PR with `gh pr edit <pr> --add-label <label>`. Do not run `gh pr merge` or `origin pr merge`, and do not arm `--auto`.
- Enqueue as soon as the PR's verdict covers its current head. Do not wait for CI or reviews, because the label means merge when ready. Retarget the PR to trunk if needed, but do not rebase it, because the queue rebases.
- Read the labels again a few seconds later. If the label is gone, Graphite rejected the GitHub actor, so stop and report it instead of merging around the queue.
- Graphite copies the label onto downstack PRs, so label only the bottom PR. Leave any `[Graphite MQ]` draft PR alone. A label that disappears later is a dequeue, so fix the branch before you enqueue it again.
- A merged PR reads `mergedAt` set or `state` `MERGED`. A labeled PR that is still open is queued, not landed.
- `gt` stays orchestrate-only and is never the land path.

When the script prints nothing, the repository has no Graphite queue, so follow the steps below as written.
