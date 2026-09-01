# CHANGE ME: a Terraform GCS backend cannot read variables, so this bucket name
# is a literal. It must be globally unique — prefix it with your project id.
terraform {
  backend "gcs" {
    bucket = "your-gcp-project-dambi-tfstate"
    prefix = "policy-server/m2"
  }
}
