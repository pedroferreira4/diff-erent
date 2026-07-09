const { stableId, unquoteGitPath } = require("./util");

function parseUnifiedDiff(diffText) {
  const lines = diffText.split(/\r?\n/);
  /** @type {Array<any>} */
  const files = [];
  let file = null;
  let hunk = null;

  for (const rawLine of lines) {
    if (rawLine.startsWith("diff --git ")) {
      file = createFile(rawLine);
      hunk = null;
      files.push(file);
      continue;
    }

    if (!file) {
      continue;
    }

    if (rawLine.startsWith("new file mode ")) {
      file.status = "added";
      continue;
    }

    if (rawLine.startsWith("deleted file mode ")) {
      file.status = "deleted";
      continue;
    }

    if (rawLine.startsWith("similarity index ")) {
      file.status = "renamed";
      continue;
    }

    if (rawLine.startsWith("rename from ")) {
      file.oldPath = rawLine.slice("rename from ".length);
      file.status = "renamed";
      continue;
    }

    if (rawLine.startsWith("rename to ")) {
      file.newPath = rawLine.slice("rename to ".length);
      file.status = "renamed";
      continue;
    }

    if (rawLine.startsWith("Binary files ") || rawLine.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }

    if (rawLine.startsWith("--- ")) {
      const oldPath = normalizeDiffPath(rawLine.slice(4));
      file.oldPath = oldPath;
      if (oldPath === "/dev/null") {
        file.status = "added";
      }
      continue;
    }

    if (rawLine.startsWith("+++ ")) {
      const newPath = normalizeDiffPath(rawLine.slice(4));
      file.newPath = newPath;
      if (newPath === "/dev/null") {
        file.status = "deleted";
      }
      continue;
    }

    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (hunkMatch) {
      hunk = {
        header: rawLine,
        oldStart: Number(hunkMatch[1]),
        oldLines: Number(hunkMatch[2] || "1"),
        newStart: Number(hunkMatch[3]),
        newLines: Number(hunkMatch[4] || "1"),
        section: hunkMatch[5] || "",
        lines: []
      };
      hunk.oldCursor = hunk.oldStart;
      hunk.newCursor = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      continue;
    }

    addHunkLine(hunk, rawLine);
  }

  for (const nextFile of files) {
    nextFile.additions = 0;
    nextFile.deletions = 0;
    nextFile.hunks.forEach((nextHunk) => {
      delete nextHunk.oldCursor;
      delete nextHunk.newCursor;
      nextHunk.lines.forEach((line) => {
        if (line.type === "add") {
          nextFile.additions += 1;
        }
        if (line.type === "delete") {
          nextFile.deletions += 1;
        }
      });
    });

    if (nextFile.status === "modified" && nextFile.oldPath !== nextFile.newPath) {
      nextFile.status = "renamed";
    }
  }

  const totals = files.reduce(
    (acc, nextFile) => {
      acc.files += 1;
      acc.additions += nextFile.additions;
      acc.deletions += nextFile.deletions;
      acc.hunks += nextFile.hunks.length;
      acc[nextFile.status] = (acc[nextFile.status] || 0) + 1;
      return acc;
    },
    {
      files: 0,
      additions: 0,
      deletions: 0,
      hunks: 0,
      added: 0,
      deleted: 0,
      modified: 0,
      renamed: 0
    }
  );

  return { files, totals };
}

function createFile(diffGitLine) {
  const parsed = parseDiffGitLine(diffGitLine);
  return {
    id: stableId(`${parsed.oldPath}:${parsed.newPath}`),
    oldPath: parsed.oldPath,
    newPath: parsed.newPath,
    status: "modified",
    binary: false,
    additions: 0,
    deletions: 0,
    hunks: []
  };
}

function parseDiffGitLine(line) {
  const rest = line.slice("diff --git ".length);
  const parts = parseGitPathTokens(rest);
  return {
    oldPath: stripDiffPrefix(parts[0] || ""),
    newPath: stripDiffPrefix(parts[1] || parts[0] || "")
  };
}

function normalizeDiffPath(rawPath) {
  const trimmed = rawPath.trim();
  if (trimmed === "/dev/null") {
    return "/dev/null";
  }

  return stripDiffPrefix(trimmed);
}

function stripDiffPrefix(value) {
  return unquoteGitPath(value).replace(/^[ab]\//, "");
}

function parseGitPathTokens(value) {
  const tokens = [];
  let index = 0;

  while (index < value.length) {
    while (value[index] === " ") {
      index += 1;
    }

    if (index >= value.length) {
      break;
    }

    if (value[index] === "\"") {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < value.length) {
        const char = value[index];
        if (char === "\"" && !escaped) {
          index += 1;
          break;
        }
        escaped = char === "\\" && !escaped;
        if (char !== "\\") {
          escaped = false;
        }
        index += 1;
      }
      tokens.push(value.slice(start, index));
      continue;
    }

    const start = index;
    while (index < value.length && value[index] !== " ") {
      index += 1;
    }
    tokens.push(value.slice(start, index));
  }

  return tokens;
}

function addHunkLine(hunk, rawLine) {
  if (rawLine.startsWith("+")) {
    hunk.lines.push({
      type: "add",
      content: rawLine.slice(1),
      oldLine: null,
      newLine: hunk.newCursor
    });
    hunk.newCursor += 1;
    return;
  }

  if (rawLine.startsWith("-")) {
    hunk.lines.push({
      type: "delete",
      content: rawLine.slice(1),
      oldLine: hunk.oldCursor,
      newLine: null
    });
    hunk.oldCursor += 1;
    return;
  }

  if (rawLine.startsWith("\\")) {
    hunk.lines.push({
      type: "meta",
      content: rawLine,
      oldLine: null,
      newLine: null
    });
    return;
  }

  const content = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
  hunk.lines.push({
    type: "context",
    content,
    oldLine: hunk.oldCursor,
    newLine: hunk.newCursor
  });
  hunk.oldCursor += 1;
  hunk.newCursor += 1;
}

module.exports = {
  parseUnifiedDiff,
  createFile,
  parseDiffGitLine,
  normalizeDiffPath,
  stripDiffPrefix,
  parseGitPathTokens,
  addHunkLine
};
