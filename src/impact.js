const fs = require("node:fs/promises");
const path = require("node:path");
const { execGit } = require("./git");
const { loadAliasConfig, aliasBaseCandidates } = require("./aliases");
const {
  SOURCE_EXTENSIONS,
  toPosixPath,
  normalizePosix,
  stripExtension,
  isLikelySourceFile,
  isDependencyFile,
  getFileKind,
  getDiffFilePath
} = require("./util");

// Per-repo cache of extracted import/re-export specifiers, keyed by file mtime.
// We cache the raw specifiers (which depend only on file content) rather than
// resolved targets (which depend on the changing candidate set), so a cache hit
// stays correct across scans while still skipping the expensive read + regex.
const specifierCache = new Map();

function getRepoCache(repoRoot) {
  let cache = specifierCache.get(repoRoot);
  if (!cache) {
    cache = new Map();
    specifierCache.set(repoRoot, cache);
  }
  return cache;
}

async function buildImpactAnalysis(repoRoot, files) {
  const changedPaths = files
    .map(getDiffFilePath)
    .filter((filePath) => filePath && filePath !== "/dev/null" && isLikelySourceFile(filePath));
  const uniqueChangedPaths = [...new Set(changedPaths)];

  if (uniqueChangedPaths.length === 0) {
    return {
      scannedFiles: 0,
      relationships: 0,
      items: [],
      edges: [],
      note: "No source files changed."
    };
  }

  try {
    const trackedFiles = (await execGit(repoRoot, ["ls-files"]))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(toPosixPath)
      .filter(isLikelySourceFile);
    const candidates = trackedFiles.slice(0, 2200);
    const candidateSet = new Set([...candidates, ...uniqueChangedPaths]);
    const aliasConfig = await loadAliasConfig(repoRoot);
    const cache = getRepoCache(repoRoot);
    const importGraph = new Map();
    const reverseGraph = new Map();
    const reexportGraph = new Map();

    for (const filePath of candidates) {
      const { imports, reexports } = await readWorkspaceImports(repoRoot, filePath, candidateSet, uniqueChangedPaths, aliasConfig, cache);
      importGraph.set(filePath, imports);
      if (reexports.length > 0) {
        reexportGraph.set(filePath, reexports);
      }

      for (const importedFile of imports) {
        if (!reverseGraph.has(importedFile)) {
          reverseGraph.set(importedFile, new Set());
        }
        reverseGraph.get(importedFile).add(filePath);
      }
    }

    // Drop cache entries for files no longer scanned so it can't grow unbounded.
    for (const cachedPath of [...cache.keys()]) {
      if (!candidateSet.has(cachedPath)) {
        cache.delete(cachedPath);
      }
    }

    const importersOf = buildBarrelAwareImporters(reverseGraph, reexportGraph);
    const dependenciesOf = buildBarrelAwareDeps(importGraph, reexportGraph);

    const changedSet = new Set(uniqueChangedPaths);
    const items = uniqueChangedPaths.map((filePath) => {
      const importedBy = [...importersOf(filePath)];
      const importsChanged = [...dependenciesOf(filePath)].filter((target) => changedSet.has(target) && target !== filePath);
      const changedImporters = importedBy.filter((importer) => changedSet.has(importer));
      const workspaceImporters = importedBy.filter((importer) => !changedSet.has(importer));
      const file = files.find((nextFile) => getDiffFilePath(nextFile) === filePath);
      const risk = getImpactRisk(filePath, workspaceImporters.length, importsChanged.length, changedImporters.length);

      return {
        path: filePath,
        kind: getFileKind(filePath),
        status: file ? file.status : "modified",
        risk: risk.level,
        riskReasons: risk.reasons,
        importsChanged: importsChanged.slice(0, 8),
        importedByChanged: changedImporters.slice(0, 8),
        importedByWorkspace: workspaceImporters.slice(0, 10),
        importedByWorkspaceCount: workspaceImporters.length
      };
    });

    // When the scan was truncated, "no importers" cannot be trusted — the file's
    // importers may simply live beyond the cap. Caveat those verdicts explicitly.
    const truncated = trackedFiles.length > candidates.length;
    if (truncated) {
      for (const item of items) {
        if (item.importedByWorkspaceCount === 0 && item.importedByChanged.length === 0) {
          item.riskReasons = [...item.riskReasons, "scan truncated — importers may be undercounted"];
        }
      }
    }

    const edges = [];
    for (const item of items) {
      for (const target of item.importsChanged) {
        edges.push({ from: item.path, to: target, type: "imports" });
      }
      for (const importer of item.importedByChanged) {
        edges.push({ from: importer, to: item.path, type: "imports" });
      }
    }

    return {
      scannedFiles: candidates.length,
      totalSourceFiles: trackedFiles.length,
      relationships: edges.length + items.reduce((sum, item) => sum + item.importedByWorkspaceCount, 0),
      truncated,
      items,
      edges,
      note: truncated
        ? `Scanned the first ${candidates.length} of ${trackedFiles.length} tracked source files.`
        : "Import relationships are based on static import, export, require, and CSS import references, following re-export barrels."
    };
  } catch (error) {
    return {
      scannedFiles: 0,
      relationships: 0,
      items: [],
      edges: [],
      note: `Impact scan unavailable: ${error.message}`
    };
  }
}

async function readWorkspaceImports(repoRoot, filePath, candidateSet, changedPaths, aliasConfig, cache) {
  const specs = await getFileSpecifiers(repoRoot, filePath, cache);
  if (!specs) {
    return { imports: [], reexports: [] };
  }

  const imports = new Set();
  const reexports = new Set();

  for (const specifier of specs.importSpecs) {
    const resolved = resolveSpecifier(filePath, specifier, candidateSet, aliasConfig, changedPaths);
    if (resolved) {
      imports.add(resolved);
    }
  }

  // `export ... from "x"` re-exports are what make a file a barrel: it forwards
  // another module's surface. Tracked separately so the graph can see through
  // barrels to the real dependency.
  for (const specifier of specs.reexportSpecs) {
    const resolved = resolveSpecifier(filePath, specifier, candidateSet, aliasConfig, changedPaths);
    if (resolved) {
      reexports.add(resolved);
    }
  }

  return { imports: [...imports], reexports: [...reexports] };
}

// Extract a file's import/re-export specifiers, reusing a cached result when the
// file's mtime is unchanged. `io` is injectable for testing. Returns null for
// unreadable / oversized / non-file paths.
async function getFileSpecifiers(repoRoot, filePath, cache, io = fs) {
  try {
    const absolutePath = path.join(repoRoot, filePath);
    const stat = await io.stat(absolutePath);
    if (!stat.isFile() || stat.size > 700 * 1024) {
      return null;
    }

    const cached = cache && cache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached;
    }

    const content = await io.readFile(absolutePath, "utf8");
    const entry = {
      mtimeMs: stat.mtimeMs,
      importSpecs: extractImportSpecifiers(content),
      reexportSpecs: extractReexportSpecifiers(content)
    };
    if (cache) {
      cache.set(filePath, entry);
    }
    return entry;
  } catch {
    return null;
  }
}

// Resolve one specifier to a tracked file: relative first, then tsconfig aliases,
// then (only without a config) suffix inference — which would otherwise invent
// false edges from shared basenames.
function resolveSpecifier(fromFile, specifier, candidateSet, aliasConfig, changedPaths) {
  const relative = resolveImportSpecifier(fromFile, specifier, candidateSet);
  if (relative) {
    return relative;
  }

  const aliased = resolveAliasImport(specifier, aliasConfig, candidateSet);
  if (aliased) {
    return aliased;
  }

  if (!aliasConfig) {
    return inferAliasImport(specifier, changedPaths);
  }

  return undefined;
}

function extractImportSpecifiers(content) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"]*\s+from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /@import\s+(?:url\()?["']([^"']+)["']\)?/g
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(content);
    while (match) {
      specifiers.add(match[1]);
      match = pattern.exec(content);
    }
  }

  return [...specifiers];
}

// Only the specifiers a file re-exports (`export * from`, `export { x } from`).
// A file with re-exports is a barrel that forwards these modules' surface.
function extractReexportSpecifiers(content) {
  const specifiers = new Set();
  const pattern = /\bexport\s+(?:type\s+)?(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+["']([^"']+)["']/g;

  let match = pattern.exec(content);
  while (match) {
    specifiers.add(match[1]);
    match = pattern.exec(content);
  }

  return [...specifiers];
}

function resolveImportSpecifier(fromFile, specifier, candidateSet) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const base = normalizePosix(path.posix.join(path.posix.dirname(fromFile), specifier));
  return probeCandidate(base, candidateSet);
}

// Resolve a bare specifier through tsconfig/jsconfig aliases into a real tracked
// file. Returns undefined for relative specifiers, protocol URLs, or when no
// alias base maps onto a known file.
function resolveAliasImport(specifier, aliasConfig, candidateSet) {
  if (!aliasConfig || specifier.startsWith(".") || /^[a-z]+:\/\//i.test(specifier)) {
    return undefined;
  }

  for (const base of aliasBaseCandidates(specifier, aliasConfig)) {
    const hit = probeCandidate(base, candidateSet);
    if (hit) {
      return hit;
    }
  }

  return undefined;
}

// Turn a base path (no extension) into a real tracked file by trying the file
// itself, each source extension, and an index file within a directory.
function probeCandidate(base, candidateSet) {
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`)
  ];

  return candidates.find((candidate) => candidateSet.has(candidate));
}

function inferAliasImport(specifier, changedPaths) {
  if (specifier.startsWith(".") || /^[a-z]+:\/\//i.test(specifier)) {
    return undefined;
  }

  const normalizedSpecifier = stripExtension(toPosixPath(specifier.replace(/^[@~]\//, "")));
  const specifierTail = normalizedSpecifier.split("/").slice(-2).join("/");

  return changedPaths.find((changedPath) => {
    const withoutExtension = stripExtension(changedPath);
    const changedTail = withoutExtension.split("/").slice(-2).join("/");
    return withoutExtension.endsWith(normalizedSpecifier) || changedTail === specifierTail;
  });
}

// Who depends on a file, seeing through barrels: if A imports barrel B and B
// re-exports X, then A is an importer of X even though it never names X. Bounded
// to `maxHops` re-export levels. Intermediary barrels are excluded from the
// result — they are plumbing, not real consumers.
function buildBarrelAwareImporters(reverseGraph, reexportGraph, maxHops = 2) {
  const forwardedBy = new Map();
  for (const [barrel, targets] of reexportGraph) {
    for (const target of targets) {
      if (!forwardedBy.has(target)) {
        forwardedBy.set(target, new Set());
      }
      forwardedBy.get(target).add(barrel);
    }
  }

  return function importersOf(file) {
    // Files whose direct importers also count as importers of `file`: `file`
    // itself plus barrels that (transitively) re-export it.
    const chain = new Set([file]);
    let frontier = [file];
    for (let hop = 0; hop < maxHops && frontier.length > 0; hop += 1) {
      const next = [];
      for (const node of frontier) {
        for (const barrel of forwardedBy.get(node) || []) {
          if (!chain.has(barrel)) {
            chain.add(barrel);
            next.push(barrel);
          }
        }
      }
      frontier = next;
    }

    const importers = new Set();
    for (const node of chain) {
      for (const importer of reverseGraph.get(node) || []) {
        importers.add(importer);
      }
    }
    for (const node of chain) {
      importers.delete(node);
    }
    return importers;
  };
}

// What a file depends on, seeing through barrels: a direct import of barrel B
// also pulls in the modules B re-exports, bounded to `maxHops` levels.
function buildBarrelAwareDeps(importGraph, reexportGraph, maxHops = 2) {
  return function dependenciesOf(file) {
    const result = new Set();
    const seen = new Set([file]);
    let frontier = [...(importGraph.get(file) || [])];
    for (let hop = 0; hop <= maxHops && frontier.length > 0; hop += 1) {
      const next = [];
      for (const dep of frontier) {
        if (seen.has(dep)) {
          continue;
        }
        seen.add(dep);
        result.add(dep);
        if (reexportGraph.has(dep)) {
          next.push(...reexportGraph.get(dep));
        }
      }
      frontier = next;
    }
    result.delete(file);
    return result;
  };
}

// Classify a changed file's blast radius and, crucially, say WHY. Returns
// { level, reasons } so the UI never shows a naked verdict a reviewer can't trust.
function getImpactRisk(filePath, workspaceImporterCount, importsChangedCount, changedImporterCount) {
  const reasons = [];
  let level = "low";

  if (isDependencyFile(filePath)) {
    reasons.push("dependency manifest — affects the whole install");
    level = "high";
  }
  if (workspaceImporterCount >= 8) {
    reasons.push(`${workspaceImporterCount} files import this`);
    level = "high";
  }
  if (changedImporterCount >= 3) {
    reasons.push(`${changedImporterCount} other changed files import this`);
    level = "high";
  }

  if (level !== "high") {
    if (workspaceImporterCount > 0) {
      reasons.push(workspaceImporterCount === 1
        ? "1 file imports this"
        : `${workspaceImporterCount} files import this`);
      level = "medium";
    }
    if (importsChangedCount > 0) {
      reasons.push(`depends on ${importsChangedCount} other changed file${importsChangedCount === 1 ? "" : "s"}`);
      level = "medium";
    }
    if (/types?|schema|contract|api/i.test(filePath)) {
      reasons.push("path looks like a shared contract (types/schema/api)");
      level = "medium";
    }
  }

  if (reasons.length === 0) {
    reasons.push("no importers found in the scanned files");
  }

  return { level, reasons };
}

module.exports = {
  buildImpactAnalysis,
  readWorkspaceImports,
  getFileSpecifiers,
  extractImportSpecifiers,
  extractReexportSpecifiers,
  resolveImportSpecifier,
  resolveSpecifier,
  resolveAliasImport,
  probeCandidate,
  buildBarrelAwareImporters,
  buildBarrelAwareDeps,
  inferAliasImport,
  getImpactRisk
};
