const cp = require("node:child_process");
const path = require("node:path");
const { toPosixPath, unquoteGitPath } = require("./util");

function execGit(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: 50 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        const acceptExitCodes = options.acceptExitCodes || [0];
        if (error && !acceptExitCodes.includes(error.code)) {
          const detail = stderr.toString().trim() || error.message;
          reject(new Error(detail));
          return;
        }

        resolve(stdout.toString());
      }
    );
  });
}

async function getRepositoryRoot(cwd) {
  const root = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
  return root.trim();
}

async function getWorkspaceChanges(repoRoot) {
  const statusText = await execGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return statusText
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseStatusLine)
    .filter(Boolean);
}

function parseStatusLine(line) {
  if (line.length < 4) {
    return undefined;
  }

  const status = line.slice(0, 2);
  const rawPath = line.slice(3);
  const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
  const filePath = normalizeStatusPath(renamedPath);

  if (!filePath) {
    return undefined;
  }

  return {
    filePath,
    status,
    statusLabel: getStatusLabel(status)
  };
}

function normalizeStatusPath(rawPath) {
  return toPosixPath(unquoteGitPath(rawPath.trim()));
}

function getStatusLabel(status) {
  if (status === "??") {
    return "untracked";
  }
  if (status.includes("U")) {
    return "conflict";
  }
  if (status.includes("A")) {
    return "added";
  }
  if (status.includes("D")) {
    return "deleted";
  }
  if (status.includes("R")) {
    return "renamed";
  }
  if (status.includes("C")) {
    return "copied";
  }
  return "modified";
}

async function isTrackedFile(repoRoot, filePath) {
  try {
    await execGit(repoRoot, ["ls-files", "--error-unmatch", "--", filePath]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} repoRoot
 * @param {{ kind: "workingTree" } | { kind: "branch", baseRef: string } | { kind: "file", repoRoot?: string, filePath: string, status?: string }} request
 */
async function createDiffRequest(repoRoot, request) {
  if (request.kind === "file") {
    const filePath = toPosixPath(request.filePath);
    const tracked = request.status === "??" ? false : await isTrackedFile(repoRoot, filePath);

    if (!tracked) {
      return {
        mode: "file",
        title: `Diff-erent: ${path.basename(filePath)}`,
        rangeLabel: `untracked -> ${filePath}`,
        baseLabel: "untracked",
        leftRef: null,
        rightRef: null,
        useWorkingTreeRight: true,
        acceptExitCodes: [0, 1],
        args: [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-index",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "/dev/null",
          filePath
        ]
      };
    }

    return {
      mode: "file",
      title: `Diff-erent: ${path.basename(filePath)}`,
      rangeLabel: `HEAD -> working tree / ${filePath}`,
      baseLabel: "HEAD",
      leftRef: "HEAD",
      rightRef: null,
      useWorkingTreeRight: true,
      args: [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "HEAD",
        "--",
        filePath
      ]
    };
  }

  if (request.kind === "workingTree") {
    return {
      mode: "workingTree",
      title: "Diff-erent: Current Changes",
      rangeLabel: "HEAD -> working tree",
      baseLabel: "HEAD",
      leftRef: "HEAD",
      rightRef: null,
      useWorkingTreeRight: true,
      args: [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "HEAD",
        "--"
      ]
    };
  }

  if (request.kind === "local") {
    // Review the whole working directory, including untracked files, and work
    // even with no commits. Assembled from multiple git calls, so it's marked
    // `composite` and produced by buildLocalDiffText rather than a single `args`.
    const hasHead = await hasCommits(repoRoot);
    return {
      mode: "local",
      composite: true,
      hasHead,
      title: "Diff-erent: Local Files",
      rangeLabel: hasHead ? "HEAD -> working tree (+ untracked)" : "no commits -> working tree",
      baseLabel: hasHead ? "HEAD" : "(no commits)",
      leftRef: hasHead ? "HEAD" : null,
      rightRef: null,
      useWorkingTreeRight: true
    };
  }

  await execGit(repoRoot, ["rev-parse", "--verify", `${request.baseRef}^{commit}`]);
  const mergeBase = (await execGit(repoRoot, ["merge-base", request.baseRef, "HEAD"])).trim();

  return {
    mode: "branch",
    title: `Diff-erent: ${request.baseRef}...HEAD`,
    rangeLabel: `${shortRef(mergeBase)} -> HEAD`,
    baseLabel: request.baseRef,
    leftRef: mergeBase,
    rightRef: "HEAD",
    useWorkingTreeRight: false,
    args: [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `${request.baseRef}...HEAD`,
      "--"
    ]
  };
}

async function hasCommits(repoRoot) {
  try {
    await execGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

// Run the diff for a request, producing unified-diff text. Normal requests are a
// single `git diff`; the local-files request is composite (tracked changes plus
// each untracked file), so it routes to buildLocalDiffText.
async function runDiff(repoRoot, diffRequest) {
  if (diffRequest.composite) {
    return buildLocalDiffText(repoRoot, diffRequest);
  }
  return execGit(repoRoot, diffRequest.args, { acceptExitCodes: diffRequest.acceptExitCodes });
}

// Assemble a working-directory review including untracked files. With commits,
// `git diff HEAD` covers tracked edits and each untracked file is added via
// --no-index. With no commits there's no HEAD to diff against, so every listed
// file is rendered as a new addition.
async function buildLocalDiffText(repoRoot, diffRequest) {
  const parts = [];

  if (diffRequest.hasHead) {
    const tracked = await execGit(repoRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      "HEAD",
      "--"
    ]);
    if (tracked.trim()) {
      parts.push(tracked.replace(/\n+$/, ""));
    }
  }

  const statusText = await execGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  const changes = statusText.split(/\r?\n/).filter(Boolean).map(parseStatusLine).filter(Boolean);

  for (const change of changes) {
    const isUntracked = change.status === "??";
    // With commits, tracked edits are already in `git diff HEAD`; only untracked
    // files need the extra --no-index pass. With no commits, everything is new.
    if (!isUntracked && diffRequest.hasHead) {
      continue;
    }
    try {
      const fileDiff = await execGit(repoRoot, [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-index",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "/dev/null",
        change.filePath
      ], { acceptExitCodes: [0, 1] });
      if (fileDiff.trim()) {
        parts.push(fileDiff.replace(/\n+$/, ""));
      }
    } catch {
      // Skip files that can't be diffed (e.g. staged-then-deleted, unreadable).
    }
  }

  return parts.join("\n");
}

async function getGitSummary(repoRoot, diffRequest) {
  try {
    const status = await execGit(repoRoot, ["status", "--short", "--branch"]);
    const branch = status.split(/\r?\n/)[0] || "";
    return {
      branch: branch.replace(/^##\s*/, ""),
      repoName: path.basename(repoRoot),
      repoRoot,
      rangeLabel: diffRequest.rangeLabel
    };
  } catch {
    return {
      branch: "",
      repoName: path.basename(repoRoot),
      repoRoot,
      rangeLabel: diffRequest.rangeLabel
    };
  }
}

function shortRef(ref) {
  return ref.length > 12 ? ref.slice(0, 12) : ref;
}

module.exports = {
  execGit,
  getRepositoryRoot,
  getWorkspaceChanges,
  parseStatusLine,
  normalizeStatusPath,
  getStatusLabel,
  isTrackedFile,
  createDiffRequest,
  hasCommits,
  runDiff,
  buildLocalDiffText,
  getGitSummary,
  shortRef
};
