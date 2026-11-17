#!/usr/bin/env bash
# Create the GitHub repository (if missing), push main and the v1.0.0 tag,
# and set the repository topics.
#
# Usage:
#   GH_TOKEN=ghp_xxx ./scripts/publish-github.sh
# or:
#   read -rs GH_TOKEN && export GH_TOKEN && ./scripts/publish-github.sh
#
# Create a classic token with the `repo` scope:
#   https://github.com/settings/tokens/new?scopes=repo&description=dsh-live-doc
#
# The token is used only in this process. It is not written to disk, not added
# to the git remote, and not printed.
set -euo pipefail

cd "$(dirname "$0")/.."

OWNER="${GITHUB_OWNER:-jiayiliust-ops}"
REPO="${GITHUB_REPO:-dsh-live-doc}"
TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-}}"
DESCRIPTION="Live co-editing for DeepSeek Harness · AI 在写、你同时改、同一份文档；AI 下次落笔前会读到你改过的版本，导出标准 .docx，无需 Office。"

if [[ -z "$TOKEN" ]]; then
  cat >&2 <<'MSG'
GH_TOKEN is not set.

1. Create a classic token with the `repo` scope:
   https://github.com/settings/tokens/new?scopes=repo&description=dsh-live-doc
2. Run:
   read -rs GH_TOKEN && export GH_TOKEN && ./scripts/publish-github.sh
MSG
  exit 1
fi

export GH_TOKEN="$TOKEN"

api() {
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $GH_TOKEN" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

# Fail early on a bad token, and keep the account honest.
LOGIN="$(api https://api.github.com/user | python3 -c 'import json,sys; print(json.load(sys.stdin)["login"])')"
if [[ "$LOGIN" != "$OWNER" ]]; then
  echo "Token belongs to '$LOGIN', but GITHUB_OWNER is '$OWNER'." >&2
  echo "Re-run with GITHUB_OWNER='$LOGIN' if that is the intended account." >&2
  exit 1
fi
echo "Authenticated as $LOGIN"

# Create the repository if it does not exist yet.
if api "https://api.github.com/repos/$OWNER/$REPO" >/dev/null 2>&1; then
  echo "Repository $OWNER/$REPO already exists"
else
  PAYLOAD="$(DESCRIPTION="$DESCRIPTION" REPO="$REPO" python3 - <<'PY'
import json, os
print(json.dumps({
    "name": os.environ["REPO"],
    "description": os.environ["DESCRIPTION"],
    "private": False,
    "has_issues": True,
    "has_projects": False,
    "has_wiki": False,
}))
PY
)"
  api -X POST https://api.github.com/user/repos -H "Content-Type: application/json" -d "$PAYLOAD" >/dev/null
  echo "Created $OWNER/$REPO"
fi

# Push the branch and tag through a one-shot credential helper. The token is
# never stored in .git/config and never appears in the remote URL.
git remote remove origin 2>/dev/null || true
git remote add origin "https://github.com/$OWNER/$REPO.git"
git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
  push -u origin main
git -c credential.helper='!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f' \
  push origin v1.0.0

# Topics make the repository discoverable.
TOPICS="$(python3 - <<'PY'
import json
print(json.dumps({"names": [
    "deepseek-harness", "dsh-plugin", "dsh-bundle", "deepseek", "docx",
    "word", "collaborative-editing", "live-editing", "office", "javascript",
]}))
PY
)"
api -X PUT "https://api.github.com/repos/$OWNER/$REPO/topics" -H "Content-Type: application/json" -d "$TOPICS" >/dev/null || true

echo
echo "Published: https://github.com/$OWNER/$REPO"
echo "Next: create the v1.0.0 release and paste docs/RELEASE-NOTES-v1.0.0.md"
