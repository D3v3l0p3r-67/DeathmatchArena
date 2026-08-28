# Working agreements

## Git: every change lands on both branches

Work is developed on `claude/deathmatch-arena-game-prs1jr` and **also published
to `main`**, so `main` is always current without waiting for a pull request to
be merged. Both branches get the identical commits.

The flow for each piece of work:

```
git fetch origin main
git rebase origin/main          # or: git checkout -B <branch> origin/main when starting fresh
# ...commit the work...
git push -u origin <branch>     # the feature branch
git push origin HEAD:main       # the same commits, fast-forward onto main
```

Rules that keep this safe:

- **`main` is only ever fast-forwarded.** Never force-push it, never rewrite its
  history. If `main` has moved ahead (someone else's merge), rebase the feature
  branch onto it first, then push — a push that would not fast-forward is a
  signal to stop and look, not to force.
- **Push to the feature branch first**, `main` second. If the second push is
  rejected, the work is still safely published and nothing is lost.
- **A merged pull request is finished.** When the branch's PR has been merged,
  restart the branch from the latest `main` (`git checkout -B <branch>
  origin/main`) rather than stacking new commits on merged history.
- The usual gate still applies before either push: typecheck clean and the full
  test suite green (`npm run typecheck && npm test`).
