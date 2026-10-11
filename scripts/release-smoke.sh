#!/usr/bin/env bash
# Only a new, isolated, network-disabled container is used. Never mount production data.
set -euo pipefail
IMAGE=${1:?Usage: release-smoke.sh IMAGE}
NAME="qq-agent-release-smoke-$$"
export QQ_AGENT_CONSOLE_TOKEN
QQ_AGENT_CONSOLE_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(32).toString('hex'))")
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
# Also check the distributable layer contents, not just the source tree.
docker run --rm --network none --read-only --entrypoint node "$IMAGE" -e '
const fs = require("fs");
for (const p of ["/app/.env", "/app/.git", "/app/artifacts", "/app/assets/avatars"]) {
  if (fs.existsSync(p)) throw new Error("Private path found in release image: " + p);
}
for (const p of ["/app/LICENSE", "/app/THIRD_PARTY_NOTICES.md"]) {
  if (!fs.existsSync(p)) throw new Error("Missing notice: " + p);
}
if (process.getuid() !== 1000) throw new Error("Expected non-root UID 1000");
const p = JSON.parse(fs.readFileSync("/app/node_modules/@tencent-connect/qqbot-connector/package.json"));
if (p.version !== "1.2.0" || p.license !== "UNLICENSED") throw new Error("Connector version/notice changed");
'
docker run -d --name "$NAME" --network none --read-only --init \
  --cap-drop ALL --security-opt no-new-privileges \
  --tmpfs /tmp:rw,nosuid,noexec,size=128m,mode=1777 \
  --tmpfs /data:rw,uid=1000,gid=1000,mode=700 \
  -e QQ_AGENT_CONSOLE_TOKEN -e QQ_AGENT_CHANNEL=qqbot "$IMAGE" >/dev/null
for attempt in $(seq 1 30); do
  if docker exec "$NAME" node -e 'fetch("http://127.0.0.1:3210/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))'; then
    echo 'Release image: non-root, isolated HTTP startup, private-path and notice checks passed.'
    exit 0
  fi
  sleep 2
done
docker logs --tail 40 "$NAME"
exit 1
