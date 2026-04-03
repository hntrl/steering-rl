import { runCommand } from "./command.mjs";

const TASK_BRANCH_PATTERN = /^agent\/P[01]-\d{2}$/;
const PROTECTED_BRANCHES = new Set(["main", "master"]);

export function isTaskBranch(branch) {
  return TASK_BRANCH_PATTERN.test(String(branch || ""));
}

export function isProtectedBranch(branch) {
  return PROTECTED_BRANCHES.has(String(branch || ""));
}

export function listMergedTaskBranches(mergedPrs) {
  const branches = [];
  for (const pr of Array.isArray(mergedPrs) ? mergedPrs : []) {
    const branch = pr.headRefName;
    if (!branch) continue;
    if (!isTaskBranch(branch)) continue;
    if (isProtectedBranch(branch)) continue;
    branches.push({
      branch,
      prNumber: pr.number,
      mergedAt: pr.mergedAt,
    });
  }
  return branches;
}

export function deleteRemoteBranch(repo, branch, options = {}) {
  const { dryRun = false, token } = options;
  if (isProtectedBranch(branch)) {
    throw new Error(`Refusing to delete protected branch: ${branch}`);
  }
  if (!isTaskBranch(branch)) {
    throw new Error(`Refusing to delete non-task branch: ${branch}`);
  }
  if (dryRun) {
    console.log(`[dry-run] Would delete remote branch ${branch} in ${repo}`);
    return { deleted: false, dryRun: true, branch };
  }

  const env = {
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    GH_NO_UPDATE_NOTIFIER: "1",
    ...(token ? { GH_TOKEN: token } : {}),
  };

  const result = runCommand(
    "gh",
    ["api", "--method", "DELETE", `/repos/${repo}/git/refs/heads/${branch}`],
    { env, allowFailure: true },
  );

  const success = result.status === 0;
  if (success) {
    console.log(`Deleted remote branch ${branch} in ${repo}`);
  } else {
    console.warn(`Failed to delete remote branch ${branch}: ${result.stderr}`);
  }
  return { deleted: success, dryRun: false, branch };
}

export function deleteMergedBranches(repo, mergedPrs, options = {}) {
  const { dryRun = false, token } = options;
  const branches = listMergedTaskBranches(mergedPrs);
  const results = [];
  for (const { branch, prNumber } of branches) {
    const result = deleteRemoteBranch(repo, branch, { dryRun, token });
    results.push({ ...result, prNumber });
  }
  return results;
}

export function deleteLocalBranch(branch, options = {}) {
  const { dryRun = false, cwd } = options;
  if (isProtectedBranch(branch)) {
    throw new Error(`Refusing to delete protected branch: ${branch}`);
  }
  if (!isTaskBranch(branch)) {
    throw new Error(`Refusing to delete non-task branch: ${branch}`);
  }
  if (dryRun) {
    console.log(`[dry-run] Would delete local branch ${branch}`);
    return { deleted: false, dryRun: true, branch };
  }

  const result = runCommand("git", ["branch", "-d", branch], {
    cwd,
    allowFailure: true,
  });

  return { deleted: result.status === 0, dryRun: false, branch };
}
