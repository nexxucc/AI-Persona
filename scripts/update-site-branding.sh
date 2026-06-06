#!/usr/bin/env bash
set -euo pipefail

TITLE="${TITLE:-Vansh Jain}"
FAVICON_TEXT="${FAVICON_TEXT:-VJ}"
WORKER_NAME="${WORKER_NAME:-ai-persona}"
PROD_URL="https://${WORKER_NAME}.vanshjain05.workers.dev"

if [ ! -f package.json ] || [ ! -f index.html ]; then
  echo "Run this from the AI-Persona repo root."
  exit 1
fi

export TITLE
mkdir -p public

python3 - <<'PY'
from pathlib import Path
import html
import os
import re

title = os.environ["TITLE"]
escaped_title = html.escape(title)

p = Path("index.html")
content = p.read_text()

title_tag = f"<title>{escaped_title}</title>"

if re.search(r"<title>.*?</title>", content, flags=re.IGNORECASE | re.DOTALL):
    content = re.sub(
        r"<title>.*?</title>",
        title_tag,
        content,
        count=1,
        flags=re.IGNORECASE | re.DOTALL,
    )
else:
    content = content.replace("</head>", f"\t{title_tag}\n</head>", 1)

favicon_tag = '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'

icon_pattern = re.compile(
    r"<link\b(?=[^>]*\brel=[\"'](?:shortcut\s+)?icon[\"'])[^>]*>",
    flags=re.IGNORECASE,
)

if icon_pattern.search(content):
    content = icon_pattern.sub(favicon_tag, content, count=1)
else:
    content = content.replace("</head>", f"\t\t{favicon_tag}\n</head>", 1)

p.write_text(content)
PY

cat > public/favicon.svg <<SVG
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" rx="14" fill="#111827"/>
  <text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle"
        font-family="Arial, sans-serif" font-size="26" font-weight="700" fill="white">${FAVICON_TEXT}</text>
</svg>
SVG

echo "Updated site title to: ${TITLE}"
echo "Updated favicon text to: ${FAVICON_TEXT}"
echo "Worker target: ${WORKER_NAME}"
echo

npm run check

npx wrangler deploy --name "$WORKER_NAME"

echo
echo "Deployed to:"
echo "$PROD_URL"
echo
echo "Live title:"
curl -fsSL "$PROD_URL" | grep -o "<title>.*</title>" || true
