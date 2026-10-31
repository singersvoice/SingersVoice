output "app_url" {
  description = "Where the app is served."
  value       = local.has_domain ? "https://${var.domain}" : "https://${local.name}.<your-account-subdomain>.workers.dev (exact URL is printed by wrangler deploy)"
}

output "google_oauth_redirect_uri" {
  description = "Add this as an Authorized redirect URI on the Google OAuth client."
  value       = local.has_domain ? "https://${var.domain}/auth/google/callback" : "https://${local.name}.<your-account-subdomain>.workers.dev/auth/google/callback"
}

output "d1_database_id" {
  value = cloudflare_d1_database.main.id
}

output "kv_namespace_id" {
  value = cloudflare_workers_kv_namespace.cache.id
}

output "r2_media_cache_bucket" {
  value = cloudflare_r2_bucket.media_cache.name
}

output "queue_name" {
  value = cloudflare_queue.jobs.queue_name
}

output "realtime_sfu_app_id" {
  description = "Cloudflare Realtime SFU app ID (the secret is pushed to the Worker as REALTIME_SFU_APP_SECRET)."
  value       = cloudflare_calls_sfu_app.realtime.uid
}

output "turn_key_id" {
  value = cloudflare_calls_turn_app.turn.uid
}

output "access_application_aud" {
  description = "Audience tag of the Zero Trust Access app protecting /publish (empty without a custom domain)."
  value       = local.access_aud
}

output "wrangler_config_path" {
  description = "Generated wrangler config; use it for `npx wrangler dev` and manual deploys."
  value       = abspath(local_file.wrangler_config.filename)
}

output "deployed_placeholder" {
  description = "True while the real Worker bundle is not built yet (the placeholder page is served)."
  value       = local.using_placeholder
}
