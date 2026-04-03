import { runCommand } from "./command.mjs";

const GH_NON_INTERACTIVE_ENV = {
  GH_PROMPT_DISABLED: "1",
  GH_PAGER: "cat",
  GH_NO_UPDATE_NOTIFIER: "1",
};

function ghBaseArgs(args) {
  return Array.isArray(args) ? args : [];
}

export function gh(args, options = {}) {
  const { token, cwd, allowFailure = false } = options;
  const env = {
    ...GH_NON_INTERACTIVE_ENV,
    ...(token ? { GH_TOKEN: token } : {}),
  };

  return runCommand("gh", ghBaseArgs(args), {
    cwd,
    env,
    allowFailure,
  });
}

export function ghJson(args, options = {}) {
  const { stdout } = gh(args, options);
  if (!stdout.trim()) {
    return null;
  }
  return JSON.parse(stdout);
}

export function issueTaskIdFromTitle(title) {
  const match = String(title).match(/\[(P[01]-\d{2})\]/);
  return match ? match[1] : null;
}

export function ensureIssueInProgress(repo, issueNumber, token) {
  gh(
    [
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-label",
      "status:in-progress",
      "--remove-label",
      "status:todo",
    ],
    { token },
  );
}

export function markIssueBlocked(repo, issueNumber, token) {
  gh(
    [
      "issue",
      "edit",
      String(issueNumber),
      "--repo",
      repo,
      "--add-label",
      "status:blocked",
      "--remove-label",
      "status:in-progress",
      "--remove-label",
      "status:in-review",
    ],
    { token },
  );
}

export function commentIssue(repo, issueNumber, body, token) {
  gh(
    [
      "issue",
      "comment",
      String(issueNumber),
      "--repo",
      repo,
      "--body",
      body,
    ],
    { token },
  );
}
