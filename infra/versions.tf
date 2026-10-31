terraform {
  required_version = ">= 1.9.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      # 5.27+ fixes the calls_turn_app key_id bug and adds import; 5.28 makes d1 read_replication optional.
      version = "~> 5.28"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.7"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }

  # State lives locally by default (infra/terraform.tfstate, git-ignored).
  # To keep state in Cloudflare R2 instead (S3-compatible, zero egress fees),
  # create a bucket + an R2 API token, then uncomment and run `terraform init -migrate-state`.
  #
  # backend "s3" {
  #   bucket                      = "singersvoice-tfstate"
  #   key                         = "prod/terraform.tfstate"
  #   region                      = "auto"
  #   endpoints                   = { s3 = "https://<ACCOUNT_ID>.r2.cloudflarestorage.com" }
  #   skip_credentials_validation = true
  #   skip_region_validation      = true
  #   skip_requesting_account_id  = true
  #   skip_metadata_api_check     = true
  #   skip_s3_checksum            = true
  #   use_path_style              = true
  #   # AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY = the R2 token's access key / secret
  # }
}

# Authenticates with the CLOUDFLARE_API_TOKEN environment variable.
# See README.md for the permissions that token needs.
provider "cloudflare" {}
