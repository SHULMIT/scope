# =============================================================================
# docker-bake.hcl — Parallel image builds for k3d local development
# =============================================================================
# Usage:
#   docker buildx bake                          # Build all services in parallel
#   docker buildx bake api                      # Build a single service
#   docker buildx bake api portal judge         # Build specific services
#
# Override registry:
#   REGISTRY=my-registry:5050 docker buildx bake
# =============================================================================

variable "REGISTRY" {
  default = "scope-0-registry.localhost:5050"
}

# Worker version args — sourced from env (k3d-build.sh exports these from versions.env)
variable "COPILOT_CLI_VERSION" {
  default = ""
}

variable "CLAUDE_CODE_ACP_VERSION" {
  default = ""
}

variable "CLAUDE_AGENT_SDK_VERSION" {
  default = ""
}

group "default" {
  targets = [
    "api",
    "judge",
    "portal",
    "token-manager",
    "scheduler",
    "gateway",
    "coder-acp-copilot",
    "coder-acp-claude-code",
  ]
}

# --- Application services ---

target "api" {
  dockerfile = "apps/api/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/api:latest"]
}

target "judge" {
  dockerfile = "apps/judge/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/judge:latest"]
}

target "portal" {
  dockerfile = "apps/portal/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/portal:latest"]
}

target "token-manager" {
  dockerfile = "apps/token-manager/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/token-manager:latest"]
}

target "scheduler" {
  dockerfile = "apps/scheduler/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/scheduler:latest"]
}

target "gateway" {
  dockerfile = "Dockerfile"
  context    = "apps/gateway"
  target     = "runtime"
  tags       = ["${REGISTRY}/scoped/gateway:latest"]
}

# --- Worker services ---

target "coder-acp-copilot" {
  dockerfile = "apps/workers/coder-acp-copilot/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/coder-acp-copilot:latest"]
  args = {
    COPILOT_CLI_VERSION = "${COPILOT_CLI_VERSION}"
  }
}

target "coder-acp-claude-code" {
  dockerfile = "apps/workers/coder-acp-claude-code/Dockerfile"
  context    = "."
  tags       = ["${REGISTRY}/scoped/coder-acp-claude-code:latest"]
  args = {
    CLAUDE_CODE_ACP_VERSION  = "${CLAUDE_CODE_ACP_VERSION}"
    CLAUDE_AGENT_SDK_VERSION = "${CLAUDE_AGENT_SDK_VERSION}"
  }
}
