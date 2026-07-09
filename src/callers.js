// Missed-caller detection: when a changed file removes/renames an exported symbol
// or changes its declaration, find files that import that symbol by name but were
// not themselves touched in the diff — the classic "updated the definition, missed
// a call site" bug. Regex-based and intentionally conservative: it reports named
// imports of directly-imported modules only.

// Note: no `default` — `export default function foo` exposes no name a consumer
// imports by, so it is intentionally not captured.
const EXPORT_DECL = /\bexport\s+(?:async\s+)?(?:function\s*\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_DECL_GLOBAL = new RegExp(EXPORT_DECL.source, "g");
const EXPORT_BRACE = /\bexport\s+(?:type\s+)?\{([^}]*)\}/g;
const IMPORT_BRACE = /\bimport\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["']([^"']+)["']/g;

// The named identifier of a `{ ... }` clause segment, from the perspective of the
// module that owns the name. For `a as b`: an export exposes `b`; an import binds
// the original `a`. `perspective` selects which side we want.
function bindingName(segment, perspective) {
  const trimmed = segment.trim();
  if (!trimmed) {
    return undefined;
  }
  const asMatch = trimmed.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
  const name = asMatch ? (perspective === "export" ? asMatch[2] : asMatch[1]) : trimmed.split(/\s+/)[0];
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : undefined;
}

// Every named symbol a module currently exports (declarations + `export { ... }`).
// Default exports are excluded: consumers don't import them by a stable name.
function extractExportedNames(content) {
  const names = new Set();

  let match = EXPORT_DECL_GLOBAL.exec(content);
  while (match) {
    names.add(match[1]);
    match = EXPORT_DECL_GLOBAL.exec(content);
  }

  match = EXPORT_BRACE.exec(content);
  while (match) {
    for (const segment of match[1].split(",")) {
      const name = bindingName(segment, "export");
      if (name && name !== "default") {
        names.add(name);
      }
    }
    match = EXPORT_BRACE.exec(content);
  }

  return names;
}

// Named imports grouped by module specifier, using the *imported* (source) name so
// they can be matched against the target module's exports.
function extractNamedImportBindings(content) {
  const bySpecifier = new Map();

  let match = IMPORT_BRACE.exec(content);
  while (match) {
    const specifier = match[2];
    if (!bySpecifier.has(specifier)) {
      bySpecifier.set(specifier, new Set());
    }
    for (const segment of match[1].split(",")) {
      const name = bindingName(segment, "import");
      if (name) {
        bySpecifier.get(specifier).add(name);
      }
    }
    match = IMPORT_BRACE.exec(content);
  }

  return bySpecifier;
}

// Export declaration names touched on added/removed diff lines of a parsed file.
function changedExportNames(file) {
  const removed = new Set();
  const added = new Set();

  for (const hunk of file.hunks || []) {
    for (const line of hunk.lines) {
      if (line.type !== "add" && line.type !== "delete") {
        continue;
      }
      const match = line.content.match(EXPORT_DECL);
      if (match) {
        (line.type === "delete" ? removed : added).add(match[1]);
      }
    }
  }

  return { removed, added };
}

// Exports affected by the change, classified by how risky they are for callers.
// `removed`: a deleted export-declaration whose name is gone from current exports
// (rename/deletion → importers break). `changed`: declaration line changed but the
// symbol is still exported (signature/behavior shift → callers may need review).
function affectedExports(file, currentExports) {
  const { removed, added } = changedExportNames(file);
  const affected = [];

  for (const name of removed) {
    if (!currentExports.has(name)) {
      affected.push({ name, kind: "removed" });
    } else if (added.has(name)) {
      affected.push({ name, kind: "changed" });
    }
  }

  return affected;
}

module.exports = {
  extractExportedNames,
  extractNamedImportBindings,
  changedExportNames,
  affectedExports
};
