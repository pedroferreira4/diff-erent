// Co-change coupling: mine recent git history for files that habitually change
// together. If the current diff touches A but not B, and A+B have changed
// together often, B is worth a look — a signal imports can't see (schema +
// migration, component + test, config + docs).

const { execGit } = require("./git");
const { toPosixPath, getDiffFilePath } = require("./util");

// ASCII record separator (0x1e) — will not appear in a path, so it cleanly
// delimits commits. `%x1e` is git's pretty-format escape that emits that byte
// (a bare control byte in --format is rejected as an invalid format).
const COMMIT_SEP = "\x1e";
const COMMIT_SEP_FORMAT = "%x1e";

const DEFAULTS = {
  maxCommits: 800,
  // Commits touching more than this are bulk/format/refactor noise — a single
  // 400-file commit would couple everything to everything. Skip them.
  maxFilesPerCommit: 40,
  minSupport: 3,
  minConfidence: 0.5,
  limit: 8
};

async function buildCoChangeAnalysis(repoRoot, files, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const changed = [...new Set(
    files.map(getDiffFilePath).filter((filePath) => filePath && filePath !== "/dev/null")
  )];

  if (changed.length === 0) {
    return { suggestions: [], commitsAnalyzed: 0 };
  }

  try {
    const log = await execGit(repoRoot, [
      "log",
      `-n${opts.maxCommits}`,
      "--no-merges",
      "--name-only",
      `--format=${COMMIT_SEP_FORMAT}`
    ]);
    const commits = parseGitLogNameOnly(log);
    const index = buildCoChangeIndex(commits, opts);
    const suggestions = suggestCoChanges(index, changed, opts);
    return { suggestions, commitsAnalyzed: commits.length };
  } catch (error) {
    return { suggestions: [], commitsAnalyzed: 0, note: `Co-change scan unavailable: ${error.message}` };
  }
}

// Split `git log --name-only --format=<sep>` output into commits, each a list of
// changed file paths.
function parseGitLogNameOnly(output) {
  return output
    .split(COMMIT_SEP)
    .map((chunk) => chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map(toPosixPath))
    .filter((paths) => paths.length > 0);
}

// Count how often each file changed and how often each pair changed together.
function buildCoChangeIndex(commits, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const fileCounts = new Map();
  const neighbors = new Map();

  const bump = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  const link = (a, b) => {
    if (!neighbors.has(a)) {
      neighbors.set(a, new Map());
    }
    bump(neighbors.get(a), b);
  };

  for (const files of commits) {
    const unique = [...new Set(files)];
    if (unique.length > opts.maxFilesPerCommit) {
      continue;
    }
    for (const file of unique) {
      bump(fileCounts, file);
    }
    for (let i = 0; i < unique.length; i += 1) {
      for (let j = i + 1; j < unique.length; j += 1) {
        link(unique[i], unique[j]);
        link(unique[j], unique[i]);
      }
    }
  }

  return { fileCounts, neighbors };
}

// For each changed file, surface unchanged files that historically change with
// it often enough (support) and reliably enough (confidence). Confidence is
// P(B changes | A changes) = co-changes(A,B) / changes(A).
function suggestCoChanges(index, changedPaths, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const { fileCounts, neighbors } = index;
  const changedSet = new Set(changedPaths);
  const candidates = new Map();

  for (const changed of changedPaths) {
    const changedCount = fileCounts.get(changed) || 0;
    if (changedCount < opts.minSupport) {
      continue;
    }

    const nbrs = neighbors.get(changed);
    if (!nbrs) {
      continue;
    }

    for (const [other, coCount] of nbrs) {
      if (changedSet.has(other) || coCount < opts.minSupport) {
        continue;
      }
      const confidence = coCount / changedCount;
      if (confidence < opts.minConfidence) {
        continue;
      }

      const existing = candidates.get(other);
      if (!existing || confidence > existing.confidence) {
        candidates.set(other, {
          path: other,
          confidence,
          support: coCount,
          withChangedFile: changed
        });
      }
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.confidence - a.confidence || b.support - a.support)
    .slice(0, opts.limit);
}

module.exports = {
  buildCoChangeAnalysis,
  parseGitLogNameOnly,
  buildCoChangeIndex,
  suggestCoChanges
};
