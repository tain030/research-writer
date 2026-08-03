# Research Writer checkout roles

Before changing this repository, inspect the checkout role:

```sh
git config --local --get researchwriter.role
```

## `developer`

- This is the writable notebook checkout.
- Source changes, commits, pushes, release version changes, and tags are made only here.
- Run `pnpm verify` before pushing a completed change to `main`.
- After pushing, run `pnpm server:check` and `pnpm server:sync` to update the server validation mirror.

## `server`

- This is the read-only validation mirror at `/home/tain/research-writer`.
- Do not edit tracked files, commit, tag, or push from this checkout.
- Read-only diagnosis and tests are allowed.
- Code reaches this checkout only through `_deploy/deploy-to-server.sh`, which requires a clean fast-forward from `origin/main` and rolls back a failed validation.
- Research Writer has no persistent server runtime. Do not add or start a development preview unless the user explicitly changes the operating model.

## Unconfigured checkout

Run `_deploy/configure-checkout.sh developer` on a development clone or `_deploy/configure-checkout.sh server` on the validation server before doing repository work.

User documents are not source code. Their Dropbox, OneDrive, iCloud, Google Drive, or Syncthing workflow remains independent from this Git deployment boundary.
