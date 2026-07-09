const fs = require("node:fs/promises");
const path = require("node:path");
const { execGit } = require("./git");
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
    const importGraph = new Map();
    const reverseGraph = new Map();

    for (const filePath of candidates) {
      const imports = await readWorkspaceImports(repoRoot, filePath, candidateSet, uniqueChangedPaths);
      importGraph.set(filePath, imports);

      for (const importedFile of imports) {
        if (!reverseGraph.has(importedFile)) {
          reverseGraph.set(importedFile, new Set());
        }
        reverseGraph.get(importedFile).add(filePath);
      }
    }

    const changedSet = new Set(uniqueChangedPaths);
    const items = uniqueChangedPaths.map((filePath) => {
      const importedBy = [...(reverseGraph.get(filePath) || [])].filter((importer) => importer !== filePath);
      const importsChanged = (importGraph.get(filePath) || []).filter((target) => changedSet.has(target) && target !== filePath);
      const changedImporters = importedBy.filter((importer) => changedSet.has(importer));
      const workspaceImporters = importedBy.filter((importer) => !changedSet.has(importer));
      const file = files.find((nextFile) => getDiffFilePath(nextFile) === filePath);

      return {
        path: filePath,
        kind: getFileKind(filePath),
        status: file ? file.status : "modified",
        risk: getImpactRisk(filePath, workspaceImporters.length, importsChanged.length, changedImporters.length),
        importsChanged: importsChanged.slice(0, 8),
        importedByChanged: changedImporters.slice(0, 8),
        importedByWorkspace: workspaceImporters.slice(0, 10),
        importedByWorkspaceCount: workspaceImporters.length
      };
    });

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
      relationships: edges.length + items.reduce((sum, item) => sum + item.importedByWorkspaceCount, 0),
      truncated: trackedFiles.length > candidates.length,
      items,
      edges,
      note: trackedFiles.length > candidates.length
        ? `Scanned the first ${candidates.length} tracked source files.`
        : "Import relationships are based on static import, export, require, and CSS import references."
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

async function readWorkspaceImports(repoRoot, filePath, candidateSet, changedPaths) {
  try {
    const absolutePath = path.join(repoRoot, filePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > 700 * 1024) {
      return [];
    }

    const content = await fs.readFile(absolutePath, "utf8");
    const specifiers = extractImportSpecifiers(content);
    const imports = new Set();

    for (const specifier of specifiers) {
      const resolved = resolveImportSpecifier(filePath, specifier, candidateSet);
      if (resolved) {
        imports.add(resolved);
        continue;
      }

      const inferred = inferAliasImport(specifier, changedPaths);
      if (inferred) {
        imports.add(inferred);
      }
    }

    return [...imports];
  } catch {
    return [];
  }
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

function resolveImportSpecifier(fromFile, specifier, candidateSet) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const base = normalizePosix(path.posix.join(path.posix.dirname(fromFile), specifier));
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

function getImpactRisk(filePath, workspaceImporterCount, importsChangedCount, changedImporterCount) {
  if (isDependencyFile(filePath) || workspaceImporterCount >= 8 || changedImporterCount >= 3) {
    return "high";
  }
  if (workspaceImporterCount > 0 || importsChangedCount > 0 || /types?|schema|contract|api/i.test(filePath)) {
    return "medium";
  }
  return "low";
}

module.exports = {
  buildImpactAnalysis,
  readWorkspaceImports,
  extractImportSpecifiers,
  resolveImportSpecifier,
  inferAliasImport,
  getImpactRisk
};
