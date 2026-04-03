#!/usr/bin/env bash
set -euo pipefail

repo_arg=""
visibility="private"
create_issues="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)
      repo_arg="$2"
      shift 2
      ;;
    --visibility)
      visibility="$2"
      shift 2
      ;;
    --no-issues)
      create_issues="false"
      shift
      ;;
    *)
      echo "Unknown arg: $1"
      exit 1
      ;;
  esac
done

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login"
  exit 1
fi

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Initializing git repository on main branch..."
  git init -b main
fi

if [[ -z "$repo_arg" ]]; then
  owner="$(gh api user -q .login)"
  repo_name="$(basename "$PWD")"
  repo="$owner/$repo_name"
else
  repo="$repo_arg"
fi

echo "Using repo: $repo"

if gh repo view "$repo" >/dev/null 2>&1; then
  echo "GitHub repo already exists: $repo"
else
  echo "Creating GitHub repo: $repo ($visibility)"
  gh repo create "$repo" "--$visibility" --source=. --remote=origin --description "Steering platform build repo"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "https://github.com/$repo.git"
fi

echo "Creating labels..."
gh label create "agent-ready" --color "5319e7" --description "Ready for coding-agent execution" --force --repo "$repo"
gh label create "status:todo" --color "d4c5f9" --description "Not started" --force --repo "$repo"
gh label create "status:in-progress" --color "fbca04" --description "In progress" --force --repo "$repo"
gh label create "status:in-review" --color "bfd4f2" --description "Awaiting human review" --force --repo "$repo"
gh label create "status:blocked" --color "b60205" --description "Blocked" --force --repo "$repo"

gh label create "priority:P0" --color "d73a4a" --description "Highest priority" --force --repo "$repo"
gh label create "priority:P1" --color "f9d0c4" --description "Secondary priority" --force --repo "$repo"
gh label create "priority:P2" --color "fbca04" --description "Tertiary priority" --force --repo "$repo"

gh label create "track:runtime" --color "0e8a16" --description "Runtime and inference" --force --repo "$repo"
gh label create "track:control-plane" --color "1d76db" --description "Contracts and profile registry" --force --repo "$repo"
gh label create "track:evaluation" --color "0052cc" --description "Evals and gate checker" --force --repo "$repo"
gh label create "track:feedback-loop" --color "006b75" --description "Trace mining and datasets" --force --repo "$repo"
gh label create "track:rollout" --color "5319e7" --description "Canary and rollback" --force --repo "$repo"

gh label create "risk:low" --color "c2e0c6" --description "Low risk change" --force --repo "$repo"
gh label create "risk:medium" --color "fef2c0" --description "Medium risk change" --force --repo "$repo"
gh label create "risk:high" --color "f9d0c4" --description "High risk change" --force --repo "$repo"

if [[ "$create_issues" == "true" ]]; then
  echo "Creating issues from task contracts..."
  node scripts/create-gh-issues.mjs --repo "$repo"
fi

if gh api "repos/$repo/branches/main" >/dev/null 2>&1; then
  echo "Configuring branch protection for main..."
  gh api --method PUT "repos/$repo/branches/main/protection" \
    -H "Accept: application/vnd.github+json" \
    --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["verify"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": true,
    "required_approving_review_count": 1
  },
  "required_conversation_resolution": true,
  "restrictions": null
}
JSON
else
  echo "Skipped branch protection: main branch not on remote yet."
  echo "After first push, run:"
  echo "gh api --method PUT repos/$repo/branches/main/protection -H 'Accept: application/vnd.github+json' --input - <<'JSON'"
  echo "{\"required_status_checks\":{\"strict\":true,\"contexts\":[\"verify\"]},\"enforce_admins\":false,\"required_pull_request_reviews\":{\"dismiss_stale_reviews\":true,\"required_approving_review_count\":1},\"required_conversation_resolution\":true,\"restrictions\":null}"
  echo "JSON"
fi

echo "Bootstrap complete."
