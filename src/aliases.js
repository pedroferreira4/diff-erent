const fs = require("node:fs/promises");
const path = require("node:path");
const { toPosixPath, normalizePosix } = require("./util");

// tsconfig/jsconfig are commonly JSONC (comments + trailing commas). Strip both
// while preserving string literals, then parse. Tolerant on purpose — a config we
// cannot read should degrade to "no aliases", never throw.
function stripJsonComments(text) {
  return text.replace(/"(?:[^"\\]|\\.)*"|\/\/.*$|\/\*[\s\S]*?\*\//gm, (match) => (match[0] === "\"" ? match : ""));
}

function parseJsonc(text) {
  const withoutComments = stripJsonComments(text);
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, "$1");
  return JSON.parse(withoutTrailingCommas);
}

// Merge compilerOptions from an `extends` chain (child overrides parent). One
// level of nesting covers the overwhelmingly common case (e.g. a shared base
// config) without turning this into a full tsconfig resolver.
async function readCompilerOptions(configPath, readFile, depth) {
  let config;
  try {
    config = parseJsonc(await readFile(configPath, "utf8"));
  } catch {
    return null;
  }

  const own = config.compilerOptions || {};
  if (typeof config.extends === "string" && depth > 0) {
    const parentPath = config.extends.startsWith(".")
      ? path.join(path.dirname(configPath), config.extends)
      : null;
    if (parentPath) {
      const resolvedParent = parentPath.endsWith(".json") ? parentPath : `${parentPath}.json`;
      const parent = await readCompilerOptions(resolvedParent, readFile, depth - 1);
      if (parent) {
        return { ...parent, ...own, paths: { ...(parent.paths || {}), ...(own.paths || {}) } };
      }
    }
  }

  return own;
}

/**
 * Load path-alias configuration for a repo. Returns { baseUrl, paths } where
 * baseUrl is posix and relative to the repo root, or null when no usable config
 * exists. readFile is injectable for testing.
 */
async function loadAliasConfig(repoRoot, readFile = fs.readFile) {
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    const compilerOptions = await readCompilerOptions(path.join(repoRoot, name), readFile, 2);
    if (!compilerOptions) {
      continue;
    }

    const hasPaths = compilerOptions.paths && Object.keys(compilerOptions.paths).length > 0;
    if (!hasPaths && !compilerOptions.baseUrl) {
      continue;
    }

    // baseUrl is relative to the config file (assumed at repo root here).
    const baseUrl = normalizePosix(toPosixPath(compilerOptions.baseUrl || "."));
    return {
      baseUrl: baseUrl === "." ? "" : baseUrl,
      paths: compilerOptions.paths || {}
    };
  }

  return null;
}

// Given a bare specifier, return the repo-root-relative base paths it could map
// to under this alias config, in priority order. Callers probe each base for
// real files (adding extensions / index). Empty array = no alias matched.
function aliasBaseCandidates(specifier, config) {
  if (!config) {
    return [];
  }

  const results = [];
  const paths = config.paths || {};

  for (const pattern of Object.keys(paths)) {
    const targets = paths[pattern] || [];
    const starIndex = pattern.indexOf("*");

    if (starIndex === -1) {
      if (pattern === specifier) {
        for (const target of targets) {
          results.push(joinBase(config.baseUrl, target));
        }
      }
      continue;
    }

    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix)
    ) {
      const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
      for (const target of targets) {
        results.push(joinBase(config.baseUrl, target.replace("*", captured)));
      }
    }
  }

  // A bare specifier can also resolve directly against baseUrl (tsconfig's
  // "non-relative module resolution"), e.g. baseUrl "src" + import "components/x".
  if (config.baseUrl !== undefined) {
    results.push(joinBase(config.baseUrl, specifier));
  }

  return [...new Set(results)];
}

function joinBase(baseUrl, target) {
  return normalizePosix(path.posix.join(baseUrl || ".", target));
}

module.exports = {
  parseJsonc,
  loadAliasConfig,
  aliasBaseCandidates
};
