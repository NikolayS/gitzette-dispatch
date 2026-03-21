#!/usr/bin/env bash
# Usage: ./push-dispatch.sh <username> <week_key> <html_file>
# Pushes a generated dispatch to R2 and inserts into D1.
set -e

USERNAME=$1
WEEK_KEY=$2
HTML_FILE=${3:-/tmp/gl-dispatch/dispatch/index.html}

CF_ACCOUNT="${CF_ACCOUNT:-a3265e0d0db71fdece29365819452f00}"
CF_TOKEN="${CF_TOKEN:?CF_TOKEN env var required}"
D1_DB="4a3624d7-7de8-46d5-91f5-7ee79856ccaa"
R2_KEY="dispatches/${USERNAME}/${WEEK_KEY}.html"

echo "→ Committing image cache to git..."
cd /tmp/gl-dispatch/dispatch
if [[ -n "$(git status --porcelain .cache/images/)" ]]; then
  git add .cache/images/
  git commit -m "cache: images for ${USERNAME} ${WEEK_KEY}" || true
  git push origin main || true
fi
cd /tmp/gl-dispatch

echo "→ Pushing $USERNAME $WEEK_KEY to R2..."
curl -s -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/r2/buckets/gitzette-dispatches/objects/$(python3 -c "import urllib.parse; print(urllib.parse.quote('${R2_KEY}', safe=''))")" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: text/html; charset=utf-8" \
  --data-binary "@${HTML_FILE}" | python3 -c "import sys,json; d=json.load(sys.stdin); print('R2:', 'ok' if d.get('success') else d)"

echo "→ Ensuring user exists in D1..."
GH_TOKEN="${GITHUB_TOKEN:-}"
AVATAR=$(curl -s "https://api.github.com/users/${USERNAME}" ${GH_TOKEN:+-H "Authorization: token ${GH_TOKEN}"} | python3 -c "import sys,json; print(json.load(sys.stdin).get('avatar_url',''))" 2>/dev/null || echo "")
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${D1_DB}/query" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"sql\":\"INSERT OR IGNORE INTO users (id, username, avatar_url) VALUES (lower(hex(randomblob(16))), '${USERNAME}', '${AVATAR}')\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('user:', 'ok' if d.get('success') else d)"

echo "→ Inserting dispatch into D1..."
curl -s -X POST \
  "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/d1/database/${D1_DB}/query" \
  -H "Authorization: Bearer ${CF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d "{\"sql\":\"INSERT INTO dispatches (user_id, week_key, r2_key, html, generated_at) SELECT id, '${WEEK_KEY}', '${R2_KEY}', '', unixepoch() FROM users WHERE username='${USERNAME}' ON CONFLICT DO NOTHING\"}" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print('D1:', 'ok' if d.get('success') else d)"

echo "✓ Done: https://gitzette.online/${USERNAME}/${WEEK_KEY}"
