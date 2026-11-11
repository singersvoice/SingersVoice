# Restore points

| Name | Ref | What it is |
| --- | --- | --- |
| **RP1** | branch `restore/RP1` (commit `5862a62`) | State before v2 execution: the original scaffold (`web/`, `api/`, `db/`, docker-compose) on `main`, plus the Cloudflare Terraform on `infra/terraform-cloudflare` (PR #1). |

Branches are never force-pushed, so a restore point is a plain branch you can read, diff or branch from at any time.

## Go back to RP1

```bash
git fetch origin
git switch -c from-rp1 origin/restore/RP1       # new branch starting at RP1 (safe)
# or, to make main itself RP1 again (destructive for main's history):
git switch main && git reset --hard origin/restore/RP1 && git push --force-with-lease origin main
```

## Tag it (optional)

The session that created RP1 could push branches but not tags through its proxy. To add a tag locally:

```bash
git tag -a RP1 origin/restore/RP1 -m "Restore point 1: before v2 execution"
git push origin RP1
```

## Make a new restore point

```bash
git switch main && git pull
git branch restore/RP2 && git push origin restore/RP2
```
