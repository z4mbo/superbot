#!/bin/sh
# Optional: clones private marketing pages into src/marketing when both WWW_MARKETING_REPO (a
# repository path such as github.com/owner/marketing.git) and GITHUB_MARKETING_TOKEN are set.
# Without them the site builds the home page and docs alone, which is a complete site.
set -eu

MARKETING_DIR="src/marketing"

if [ -z "${WWW_MARKETING_REPO:-}" ] || [ -z "${GITHUB_MARKETING_TOKEN:-}" ]; then
  echo "No marketing repository configured: building the home page and docs."
  exit 0
fi

if [ -d "$MARKETING_DIR" ]; then
  echo "$MARKETING_DIR already exists."
  exit 0
fi

(set +x; git clone --quiet --depth 1 "https://x-access-token:${GITHUB_MARKETING_TOKEN}@${WWW_MARKETING_REPO}" "$MARKETING_DIR")
git -C "$MARKETING_DIR" remote set-url origin "https://${WWW_MARKETING_REPO}"
echo "Cloned marketing pages into $MARKETING_DIR."
