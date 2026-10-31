# Deploys the Worker (API + Durable Object room + SPA assets) with wrangler as the
# last step of `terraform apply`, and pushes the runtime secrets.
#
# Terraform owns the infrastructure; wrangler owns code upload, static assets,
# Durable Object migrations and the custom domain route — the things the
# Cloudflare API expects a deploy tool to do. Day-to-day app releases can run
# `npx wrangler deploy --config infra/.generated/wrangler.jsonc` directly (or CI);
# `terraform apply` re-deploys whenever the generated config or the Worker bundle changes.

locals {
  placeholder_worker = abspath("${path.module}/placeholder/worker.js")
  placeholder_assets = abspath("${path.module}/placeholder/public")

  requested_worker_entry = abspath("${path.module}/${var.worker_entry}")
  requested_assets_dir   = abspath("${path.module}/${var.assets_dir}")
  requested_migrations   = abspath("${path.module}/${var.d1_migrations_dir}")

  worker_entry = fileexists(local.requested_worker_entry) ? local.requested_worker_entry : local.placeholder_worker
  assets_dir   = fileexists("${local.requested_assets_dir}/index.html") ? local.requested_assets_dir : local.placeholder_assets
  using_placeholder = local.worker_entry == local.placeholder_worker

  d1_migrations_dir = length(fileset(local.requested_migrations, "*.sql")) > 0 ? local.requested_migrations : ""

  access_aud         = local.has_domain ? one(cloudflare_zero_trust_access_application.publishing_console[*].aud) : ""
  access_team_domain = var.access_team_name != "" ? "https://${var.access_team_name}.cloudflareaccess.com" : ""

  wrangler_config = templatefile("${path.module}/templates/wrangler.jsonc.tftpl", {
    name               = local.name
    account_id         = var.cloudflare_account_id
    environment        = var.environment
    worker_entry       = local.worker_entry
    assets_dir         = local.assets_dir
    compatibility_date = var.compatibility_date
    has_domain         = local.has_domain
    domain             = var.domain
    google_client_id   = var.google_client_id
    admin_emails       = join(",", var.admin_emails)
    access_aud         = local.access_aud
    access_team_domain = local.access_team_domain
    d1_name            = cloudflare_d1_database.main.name
    d1_id              = cloudflare_d1_database.main.id
    d1_migrations_dir  = local.d1_migrations_dir
    kv_id              = cloudflare_workers_kv_namespace.cache.id
    r2_bucket          = cloudflare_r2_bucket.media_cache.name
    queue_name         = cloudflare_queue.jobs.queue_name
  })

  # Secrets pushed with `wrangler secret bulk`. Never written to the repo.
  worker_secrets = {
    GOOGLE_CLIENT_SECRET     = var.google_client_secret
    SESSION_SECRET           = random_password.session_secret.result
    TOKEN_ENCRYPTION_KEY     = random_bytes.token_encryption_key.base64
    REALTIME_SFU_APP_ID      = cloudflare_calls_sfu_app.realtime.uid
    REALTIME_SFU_APP_SECRET  = cloudflare_calls_sfu_app.realtime.secret
    TURN_KEY_ID              = cloudflare_calls_turn_app.turn.uid
    TURN_KEY_API_TOKEN       = cloudflare_calls_turn_app.turn.key
    CLOUDFLARE_STREAM_TOKEN  = cloudflare_account_token.worker_runtime.value
  }
}

resource "local_file" "wrangler_config" {
  filename        = "${path.module}/.generated/wrangler.jsonc"
  content         = local.wrangler_config
  file_permission = "0644"
}

resource "terraform_data" "deploy" {
  count = var.deploy_worker ? 1 : 0

  triggers_replace = {
    config  = local_file.wrangler_config.content
    worker  = filesha256(local.worker_entry)
    secrets = sha256(jsonencode(local.worker_secrets))
    nonce   = var.force_redeploy ? timestamp() : "stable"
  }

  provisioner "local-exec" {
    working_dir = path.module
    interpreter = ["/bin/bash", "-c"]
    environment = {
      CLOUDFLARE_ACCOUNT_ID = var.cloudflare_account_id
      WRANGLER_SEND_METRICS = "false"
      SECRETS_JSON          = jsonencode(local.worker_secrets)
      WRANGLER              = "npx --yes wrangler@${var.wrangler_version}"
      HAS_MIGRATIONS        = local.d1_migrations_dir != "" ? "1" : "0"
    }
    command = <<-EOT
      set -euo pipefail
      echo ">> wrangler deploy"
      $WRANGLER deploy --config .generated/wrangler.jsonc
      if [ "$HAS_MIGRATIONS" = "1" ]; then
        echo ">> applying D1 migrations"
        $WRANGLER d1 migrations apply DB --remote --config .generated/wrangler.jsonc
      fi
      echo ">> pushing secrets"
      tmp="$(mktemp)"; chmod 600 "$tmp"
      printf '%s' "$SECRETS_JSON" > "$tmp"
      $WRANGLER secret bulk "$tmp" --config .generated/wrangler.jsonc
      rm -f "$tmp"
      echo ">> deploy complete"
    EOT
  }

  depends_on = [
    cloudflare_d1_database.main,
    cloudflare_workers_kv_namespace.cache,
    cloudflare_r2_bucket.media_cache,
    cloudflare_queue.jobs,
    cloudflare_calls_sfu_app.realtime,
    cloudflare_calls_turn_app.turn,
    cloudflare_account_token.worker_runtime,
  ]
}
