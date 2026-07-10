# Contributing

## Workflow rules

1. **Always use worktrees** for coding work. Don't pollute `main`.
2. **Never push to remote `main` directly**. Merge into local main only; only designated release managers push remote main.
3. After completing work on a worktree branch, run `pnpm -w build` + `pnpm -w test` + `pnpm -w lint` before requesting merge.

## Local dev setup

```sh
# clone
gh repo clone botiverse/hands
cd hands

# install
pnpm install

# set up worktree for a feature
git worktree add -b feat/<lane>-<slice> ../hands-<slice> main
cd ../hands-<slice>
```

## Deploy

```sh
# 1. apply D1 migrations
pnpm --filter @botiverse/hands-worker exec wrangler d1 migrations apply quiver-db

# 2. deploy worker + container
pnpm --filter @botiverse/hands-worker exec wrangler deploy

# 3. deploy admin UI
pnpm --filter @botiverse/hands-admin exec wrangler pages deploy ./dist
```
