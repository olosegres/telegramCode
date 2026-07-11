#!/usr/bin/env bash
# telegramcode self-update — pull-based deployment refresh, no root required.
#
# Run as the checkout's OWNING user (interactively or from cron). Safe by
# construction: fast-forward only; skips silently when the tree has tracked
# changes, a merge/rebase is in progress, or local history diverged from the
# upstream (a dev clone that is ahead of origin is normal and is never touched).
#
# A hot-mode instance (`telegramcode hot`: tsc -w + nodemon) picks the pulled
# source up automatically; a non-hot instance gets `yarn build` here plus a
# restart notice — this script never kills or restarts processes itself.
set -euo pipefail

repoDir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repoDir"

log() { printf '[self-update] %s\n' "$*"; }

# cron ships a minimal environment — load nvm so node/yarn resolve.
if ! command -v yarn >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
command -v git >/dev/null 2>&1 || { log "git not found"; exit 1; }
command -v yarn >/dev/null 2>&1 || { log "yarn not found (nvm not loadable?)"; exit 1; }
[ -d .git ] || { log "$repoDir is not a git checkout"; exit 1; }

# One run at a time (cron-overlap guard).
exec 9>"$repoDir/.git/self-update.lock"
flock -n 9 || { log "another self-update is already running — skip"; exit 0; }

# Never touch a checkout mid-work.
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ]; then
  log "merge/rebase in progress — skip"
  exit 0
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  log "tracked changes in the working tree — skip"
  exit 0
fi

upstream="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
if [ -z "$upstream" ]; then
  log "current branch tracks no upstream — skip"
  exit 0
fi

git fetch --quiet origin

localHead="$(git rev-parse '@')"
remoteHead="$(git rev-parse '@{u}')"
if [ "$localHead" = "$remoteHead" ]; then
  log "already up to date ($(git rev-parse --short '@'))"
  exit 0
fi

mergeBase="$(git merge-base '@' '@{u}')"
if [ "$localHead" != "$mergeBase" ]; then
  log "local history is ahead of / diverged from $upstream — skip (dev clone?)"
  exit 0
fi

git merge --ff-only --quiet '@{u}'
log "updated $(git rev-parse --short "$localHead")..$(git rev-parse --short '@') ($(git rev-list --count "$localHead..HEAD") commits)"

changedFiles="$(git diff --name-only "$localHead" HEAD)"
checkChanged() { printf '%s\n' "$changedFiles" | grep -qxE "$1"; }

manifestChanged=0
if checkChanged 'yarn\.lock|package\.json'; then
  manifestChanged=1
  log "dependency manifest changed — running yarn install"
  yarn install --immutable
fi

# A running hot supervisor (tsc -w on THIS checkout) rebuilds dist and nodemon
# restarts the worker on its own; build here only when no watcher owns the dir.
if pgrep -f "$repoDir/node_modules/.bin/tsc" >/dev/null 2>&1; then
  log "hot mode detected — tsc -w rebuilds, nodemon restarts the worker"
  if [ "$manifestChanged" = 1 ]; then
    # tsc -w does not re-resolve modules installed after a failed compile;
    # touching tsconfig forces a full reconfigure+recompile with the new deps.
    touch tsconfig.json
    log "nudged tsc -w (touch tsconfig.json) to recompile with the new dependencies"
  fi
else
  log "no hot watcher on this checkout — building"
  yarn build
  log "NOTE: restart the bot process to pick up the new build (this script never restarts anything)"
fi

# The hot SUPERVISOR does not reload itself (nodemon restarts only the worker):
# changes to these files need a manual `telegramcode hot` restart by the operator.
if checkChanged 'src/cli\.ts|src/cli/hot\.ts|nodemon\.json'; then
  log "WARNING: hot-supervisor files changed (src/cli.ts / src/cli/hot.ts / nodemon.json) — restart 'telegramcode hot' manually"
fi
