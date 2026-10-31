# Cloudflare Zero Trust Access in front of Publishing Mode (the admin console).
#
# Only created when a custom domain is configured: Access can protect hostnames on a
# zone in your account, not *.workers.dev. Free for up to 50 users.
# One-time prerequisite: open Zero Trust in the dashboard once and pick a team name.
#
# Admins sign in with a one-time PIN sent to an allow-listed email (or Google, if you
# add it as an identity provider in Zero Trust). The Worker additionally verifies the
# Access JWT (Cf-Access-Jwt-Assertion) against the application's `aud` on /api/publish/*.

locals {
  admin_paths = ["publish", "api/publish"]
  admin_uris  = [for p in local.admin_paths : "${var.domain}/${p}"]
}

resource "cloudflare_zero_trust_access_policy" "admins" {
  count = local.has_domain ? 1 : 0

  account_id       = var.cloudflare_account_id
  name             = "${local.name}-admins"
  decision         = "allow"
  session_duration = var.access_session_duration # optional since provider 5.24, but omitting it shows a perpetual diff

  include = [for email in var.admin_emails : { email = { email = email } }]

  lifecycle {
    precondition {
      condition     = length(var.admin_emails) > 0
      error_message = "admin_emails must list at least one Google account email when `domain` is set."
    }
  }
}

resource "cloudflare_zero_trust_access_application" "publishing_console" {
  count = local.has_domain ? 1 : 0

  account_id       = var.cloudflare_account_id
  name             = "${local.name} publishing console"
  type             = "self_hosted"
  domain           = local.admin_uris[0]
  session_duration = var.access_session_duration

  # `destinations` supersedes the deprecated `self_hosted_domains`.
  destinations = [for uri in local.admin_uris : { type = "public", uri = uri }]

  policies = [{
    id         = cloudflare_zero_trust_access_policy.admins[0].id
    precedence = 1
  }]

  app_launcher_visible       = false
  auto_redirect_to_identity  = false
  http_only_cookie_attribute = true
}
