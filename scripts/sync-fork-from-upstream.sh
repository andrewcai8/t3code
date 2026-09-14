#!/bin/sh
# Merge pingdotgg/t3code into a local sync branch. Does not push.
# Use this when GitHub's merge-upstream returns 409.
set -eu

cd "$(git rev-parse --show-toplevel)"
git remote show upstream >/dev/null 2>&1 || git remote add upstream https://github.com/pingdotgg/t3code.git
git fetch --prune origin
git fetch --prune upstream

base=$(git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || echo origin/main)
base=${base#origin/}
stamp=$(date -u +%Y%m%d)
branch="sync/upstream-${stamp}"

if git show-ref --verify --quiet "refs/heads/${branch}"; then
  echo "$branch already exists. Check it out and continue the merge." >&2
  exit 1
fi

git checkout -b "$branch" "origin/${base}"
if git merge --no-edit "upstream/${base}"; then
  echo "Merged upstream/${base} into ${branch}."
  echo "Review, then: git push -u origin ${branch} && gh pr create --base ${base}"
  exit 0
fi

echo "Conflicts remain on ${branch}." >&2
echo "Resolve them, commit, then open a PR into ${base}." >&2
echo "Do not run git merge --abort unless you want to discard this attempt." >&2
exit 1
