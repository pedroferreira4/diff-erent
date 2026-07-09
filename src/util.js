const path = require("node:path");

// File extensions the impact scanner treats as source it can parse for imports.
const SOURCE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".cts",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".pcss",
  ".json",
  ".graphql",
  ".gql"
];

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function normalizePosix(filePath) {
  return toPosixPath(path.posix.normalize(filePath));
}

function stripExtension(filePath) {
  return toPosixPath(filePath).replace(/\.[^.\/]+$/, "");
}

function unquoteGitPath(value) {
  if (!value) {
    return value;
  }

  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  return value;
}

function isLikelySourceFile(filePath) {
  return SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function isDependencyFile(filePath) {
  return /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|requirements\.txt|Cargo\.toml|go\.mod)$/i.test(filePath);
}

function isStyleFile(filePath) {
  return /\.(css|scss|sass|less|pcss)$/i.test(filePath);
}

function getDiffFilePath(file) {
  return file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
}

function getFileKind(filePath) {
  if (!filePath) {
    return "file";
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(filePath) || /(^|\/)(__tests__|test|tests)\//i.test(filePath)) {
    return "test";
  }
  if (isDependencyFile(filePath)) {
    return "dependency";
  }
  if (/\.(css|scss|sass|less|pcss)$/i.test(filePath)) {
    return "style";
  }
  if (/\.(tsx|jsx|vue|svelte)$/i.test(filePath)) {
    return "ui";
  }
  if (/\.(ts|js|mts|mjs|cts|cjs)$/i.test(filePath)) {
    return "code";
  }
  if (/\.(json|ya?ml|toml|ini)$/i.test(filePath)) {
    return "config";
  }
  if (/\.(md|mdx|txt)$/i.test(filePath)) {
    return "docs";
  }
  return "file";
}

function stableId(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

module.exports = {
  SOURCE_EXTENSIONS,
  toPosixPath,
  normalizePosix,
  stripExtension,
  unquoteGitPath,
  isLikelySourceFile,
  isDependencyFile,
  isStyleFile,
  getDiffFilePath,
  getFileKind,
  stableId
};
