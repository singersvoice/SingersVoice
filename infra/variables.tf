variable "cloudflare_account_id" {
  description = "Cloudflare account ID (Dashboard > Workers & Pages > right sidebar, or `wrangler whoami`)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.cloudflare_account_id))
    error_message = "cloudflare_account_id must be the 32-character hex account ID."
  }
}

variable "project_name" {
  description = "Short name used as a prefix for every resource."
  type        = string
  default     = "singersvoice"

  validation {
    condition     = can(regex("^[a-z][a-z0-9-]{1,30}$", var.project_name))
    error_message = "project_name must be lowercase letters, digits and dashes (2-31 chars)."
  }
}

variable "environment" {
  description = "Deployment environment suffix (prod, staging, dev)."
  type        = string
  default     = "prod"
}

variable "domain" {
  description = <<-EOT
    Optional custom hostname for the app, e.g. "sing.example.com".
    The parent zone (example.com) must already be on Cloudflare in this account.
    Leave empty to use the free <name>.<account>.workers.dev URL.
    Cloudflare Access protection of the admin/publishing console needs a custom domain.
  EOT
  type        = string
  default     = ""
}

variable "zone_name" {
  description = "Cloudflare zone that holds `domain` (defaults to the last two labels of `domain`; set explicitly for TLDs like .co.uk)."
  type        = string
  default     = ""
}

variable "google_client_id" {
  description = "Google OAuth 2.0 Web client ID used for Sign in with Google + Drive linking."
  type        = string
}

variable "google_client_secret" {
  description = "Google OAuth 2.0 Web client secret."
  type        = string
  sensitive   = true
}

variable "admin_emails" {
  description = "Google account emails allowed into Publishing Mode (admin console)."
  type        = list(string)
  default     = []
}

variable "deploy_worker" {
  description = "Run `wrangler deploy` (code + static assets + secrets) as part of terraform apply."
  type        = bool
  default     = true
}

variable "worker_entry" {
  description = "Path (relative to infra/) to the built Worker entry module. Falls back to the placeholder until the app exists."
  type        = string
  default     = "../worker/dist/index.js"
}

variable "assets_dir" {
  description = "Path (relative to infra/) to the built SPA (static assets). Falls back to the placeholder until the app exists."
  type        = string
  default     = "../web/dist"
}

variable "d1_migrations_dir" {
  description = "Path (relative to infra/) to D1 SQL migrations applied on deploy (skipped if the directory does not exist)."
  type        = string
  default     = "../worker/migrations"
}

variable "d1_location_hint" {
  description = "Where D1 stores the primary database: wnam, enam, weur, eeur, apac, oc."
  type        = string
  default     = "enam"
}

variable "r2_location" {
  description = "R2 bucket location hint: WNAM, ENAM, WEUR, EEUR, APAC, OC."
  type        = string
  default     = "ENAM"
}

variable "media_cache_ttl_days" {
  description = "Days before objects in the media cache bucket are deleted (Google Drive stays the system of record)."
  type        = number
  default     = 30
}

variable "stream_permission_group_name" {
  description = "Name of the Cloudflare API permission group that lets the Worker manage Stream live inputs/outputs."
  type        = string
  default     = "Stream Write"
}

variable "access_session_duration" {
  description = "How long an admin stays signed in to the publishing console through Cloudflare Access."
  type        = string
  default     = "24h"
}

variable "access_team_name" {
  description = "Your Zero Trust team name (the <team> in https://<team>.cloudflareaccess.com). Needed by the Worker to verify Access JWTs on admin routes."
  type        = string
  default     = ""
}

variable "compatibility_date" {
  description = "Workers runtime compatibility date written into the generated wrangler config."
  type        = string
  default     = "2026-10-01"
}

variable "force_redeploy" {
  description = "Set to true for one apply to force a wrangler deploy even if nothing changed."
  type        = bool
  default     = false
}

variable "wrangler_version" {
  description = "Wrangler version used by the deploy step (run via npx)."
  type        = string
  default     = "4"
}
