# SingersVoice — Cloudflare infrastructure
#
# Everything the app needs on Cloudflare, created in one `terraform apply`:
#
#   D1 (SQLite)          metadata: users, sessions, performances, Drive file pointers
#   KV                   short-lived state: OAuth nonces, rate limits, hot lookups
#   R2                   media cache in front of Google Drive (zero egress fees)
#   Queue                background jobs after a session ends (Drive sharing, mixdown pointers)
#   Realtime SFU + TURN  WebRTC for User Mode (up to 5 singers per room)
#   Account API token    lets the Worker create Stream live inputs/outputs for Publishing Mode
#   Zero Trust Access    gates the admin publishing console (only with a custom domain)
#   Worker + assets      the API, the Durable Object room, and the SPA — deployed by wrangler (deploy.tf)
#
# Google Drive is the system of record for recordings; nothing here stores media long-term.

locals {
  name       = "${var.project_name}-${var.environment}"
  has_domain = var.domain != ""

  # "sing.example.com" -> "example.com" (override with var.zone_name for multi-label TLDs such as .co.uk)
  domain_labels     = split(".", var.domain)
  derived_zone_name = local.has_domain ? join(".", slice(local.domain_labels, max(length(local.domain_labels) - 2, 0), length(local.domain_labels))) : ""
  zone_name         = var.zone_name != "" ? var.zone_name : local.derived_zone_name
}

# Used only to fail early with a clear message if the token cannot see the account.
data "cloudflare_accounts" "me" {
  lifecycle {
    postcondition {
      condition     = contains([for a in self.result : a.id], var.cloudflare_account_id)
      error_message = "CLOUDFLARE_API_TOKEN cannot see account ${var.cloudflare_account_id}. Check the token's account scope and permissions (see infra/README.md)."
    }
  }
}

# ---------------------------------------------------------------------------
# Storage
# ---------------------------------------------------------------------------

resource "cloudflare_d1_database" "main" {
  account_id            = var.cloudflare_account_id
  name                  = "${local.name}-db"
  primary_location_hint = var.d1_location_hint
}

resource "cloudflare_workers_kv_namespace" "cache" {
  account_id = var.cloudflare_account_id
  title      = "${local.name}-kv"
}

resource "cloudflare_r2_bucket" "media_cache" {
  account_id = var.cloudflare_account_id
  name       = "${local.name}-media-cache"
  location   = var.r2_location
}

# The cache is disposable: Google Drive keeps the originals, so expire everything after N days.
resource "cloudflare_r2_bucket_lifecycle" "media_cache" {
  account_id  = var.cloudflare_account_id
  bucket_name = cloudflare_r2_bucket.media_cache.name

  rules = [{
    id         = "expire-cached-media"
    enabled    = true
    conditions = { prefix = "" }
    delete_objects_transition = {
      condition = { type = "Age", max_age = var.media_cache_ttl_days * 86400 }
    }
    abort_multipart_uploads_transition = {
      condition = { type = "Age", max_age = 86400 }
    }
  }]
}

resource "cloudflare_queue" "jobs" {
  account_id = var.cloudflare_account_id
  queue_name = "${local.name}-jobs"
}

# ---------------------------------------------------------------------------
# Real-time media (User Mode): Cloudflare Realtime SFU + TURN
# ---------------------------------------------------------------------------

resource "cloudflare_calls_sfu_app" "realtime" {
  account_id = var.cloudflare_account_id
  name       = "${local.name}-sfu"
}

resource "cloudflare_calls_turn_app" "turn" {
  account_id = var.cloudflare_account_id
  name       = "${local.name}-turn"
}

# ---------------------------------------------------------------------------
# Runtime API token (Publishing Mode): the Worker creates Stream live inputs
# and restream outputs on demand. Scoped to Stream only, to this account only.
# ---------------------------------------------------------------------------

# The `name` filter must be URL-encoded; API names use "Write" where the dashboard says "Edit".
data "cloudflare_account_api_token_permission_groups_list" "stream" {
  account_id = var.cloudflare_account_id
  name       = urlencode(var.stream_permission_group_name)
  scope      = "com.cloudflare.api.account"
}

locals {
  stream_permission_group_ids = [
    for g in data.cloudflare_account_api_token_permission_groups_list.stream.result : g.id
    if g.name == var.stream_permission_group_name
  ]
}

resource "cloudflare_account_token" "worker_runtime" {
  account_id = var.cloudflare_account_id
  name       = "${local.name}-worker-runtime"

  policies = [{
    effect            = "allow"
    permission_groups = [{ id = local.stream_permission_group_ids[0] }]
    resources = jsonencode({
      "com.cloudflare.api.account.${var.cloudflare_account_id}" = "*"
    })
  }]

  lifecycle {
    precondition {
      condition     = length(local.stream_permission_group_ids) == 1
      error_message = "Permission group \"${var.stream_permission_group_name}\" not found (or ambiguous). List names with: curl -s -H \"Authorization: Bearer $CLOUDFLARE_API_TOKEN\" https://api.cloudflare.com/client/v4/accounts/${var.cloudflare_account_id}/tokens/permission_groups | jq '.result[].name'"
    }
  }
}

# ---------------------------------------------------------------------------
# App secrets generated once and kept in state
# ---------------------------------------------------------------------------

# Signs the app's own session cookies (JWT/HMAC).
resource "random_password" "session_secret" {
  length  = 64
  special = false
}

# AES-256-GCM key used to encrypt Google refresh tokens at rest in D1.
resource "random_bytes" "token_encryption_key" {
  length = 32
}
