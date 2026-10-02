#!/usr/bin/env bash
# Image smoke test: run the built image the way production does (read-only
# root fs, only /tmp writable, all caps dropped) and check it really serves
# the site. Usage: tests/image/smoke.sh <image> <expected-version>
set -euo pipefail
img=$1; want=$2
cid=$(docker run -d --read-only --tmpfs /tmp --cap-drop ALL \
      --security-opt no-new-privileges:true -p 18080:8080 "$img")
trap 'docker logs "$cid" 2>&1 | tail -20; docker rm -f "$cid" >/dev/null' EXIT
for _ in $(seq 1 30); do curl -fsS -o /dev/null http://127.0.0.1:18080/ && break; sleep 1; done
root=$(curl -fsS http://127.0.0.1:18080/)
grep -q '<div id="root">' <<<"$root" || { echo "FAIL: / is not the SPA index"; exit 1; }
deep=$(curl -fsS http://127.0.0.1:18080/some/deep/link)
[ "$deep" = "$root" ] || { echo "FAIL: deep link did not fall back to index.html"; exit 1; }
got=$(curl -fsS http://127.0.0.1:18080/version.txt)
[ "$got" = "$want" ] || { echo "FAIL: version.txt '$got' != '$want'"; exit 1; }
uid=$(docker exec "$cid" id -u)
[ "$uid" != 0 ] || { echo "FAIL: runs as root"; exit 1; }
h=starting
for _ in $(seq 1 30); do
  h=$(docker inspect -f '{{.State.Health.Status}}' "$cid"); [ "$h" = healthy ] && break; sleep 2
done
[ "$h" = healthy ] || { echo "FAIL: health=$h"; exit 1; }
echo "smoke OK (uid $uid, version $got, $h)"
