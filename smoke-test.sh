#!/usr/bin/env bash
# Smoke test: check all homepage dispatch links return real content
# Usage: ./smoke-test.sh
set -e

echo "=== gitzette smoke test ==="
echo ""

HOMEPAGE=$(curl -s "https://gitzette.online")
LINKS=$(echo "$HOMEPAGE" | python3 -c "
import sys, re
html = sys.stdin.read()
links = re.findall(r'href=\"(/[^\"]+/2026-W\d+)\"', html)
seen = set()
for l in links:
    if l not in seen:
        seen.add(l)
        print(l)
")

FAIL=0
for path in $LINKS; do
  HTML=$(curl -s "https://gitzette.online${path}")
  SIZE=${#HTML}
  ARTICLES=$(echo "$HTML" | python3 -c "import sys,re; html=sys.stdin.read(); a=len(re.findall(r'<div class=\"article\">', html)); h=len(re.findall(r'<h[12][^>]*>', html)); print(max(a, 1 if h > 2 else 0))")
  if [[ "$ARTICLES" -eq 0 ]]; then
    echo "  ✗ ${path} — 0 articles (${SIZE} bytes)"
    FAIL=1
  else
    echo "  ✓ ${path} — ${ARTICLES} articles"
  fi
done

echo ""
if [[ "$FAIL" -eq 1 ]]; then
  echo "FAILED — some links have no content"
  exit 1
else
  echo "ALL OK"
fi
