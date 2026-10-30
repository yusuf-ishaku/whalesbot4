#!/usr/bin/env bash
# One-command deploy. Records the git revision as the deployment's code version.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] || { echo "Missing .env (copy .env.example and fill it in)"; exit 1; }
export CODE_VERSION="${CODE_VERSION:-$(git rev-parse --short HEAD 2>/dev/null || echo dev)}"
echo "Deploying version $CODE_VERSION"
docker compose up -d --build
echo "Waiting for health..."
for i in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT:-3000}/health" >/dev/null 2>&1; then curl -s "http://localhost:${PORT:-3000}/health"; echo; exit 0; fi
  sleep 2
done
echo "App did not become healthy; see: docker compose logs app"; exit 1
