const test = require("node:test");
const assert = require("node:assert/strict");

const { parseUnifiedDiff } = require("../src/diff");
const { enrichParsedDiff } = require("../src/enrich");
const { getImpactRisk, extractImportSpecifiers, resolveImportSpecifier } = require("../src/impact");
const { getFileKind, isDependencyFile, getDiffFilePath } = require("../src/util");

const SAMPLE_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -1,3 +1,4 @@ export function foo() {",
  " const a = 1;",
  "-  return a;",
  "+  const b = 2;",
  "+  return a + b;",
  " }",
  "diff --git a/styles/app.css b/styles/app.css",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/styles/app.css",
  "@@ -0,0 +1,2 @@",
  "+.app { display: flex; }",
  "+.app > .row { color: #fff; }"
].join("\n");

test("parseUnifiedDiff splits files, counts lines, and detects status", () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.totals.files, 2);

  const [foo, css] = parsed.files;
  assert.equal(getDiffFilePath(foo), "src/foo.ts");
  assert.equal(foo.status, "modified");
  assert.equal(foo.additions, 2);
  assert.equal(foo.deletions, 1);

  assert.equal(css.status, "added");
  assert.equal(css.additions, 2);
});

test("enrichParsedDiff labels hunks and tags files", () => {
  const parsed = parseUnifiedDiff(SAMPLE_DIFF);
  enrichParsedDiff(parsed);

  const [foo, css] = parsed.files;
  assert.equal(foo.kind, "code");
  assert.ok(foo.hunks[0].insight.labels.includes("logic"));
  assert.equal(css.kind, "style");
  assert.ok(css.hunks[0].insight.labels.includes("styles"));
  assert.equal(typeof parsed.totals.weight, "number");
});

test("getFileKind and isDependencyFile classify paths", () => {
  assert.equal(getFileKind("src/foo.ts"), "code");
  assert.equal(getFileKind("src/Button.tsx"), "ui");
  assert.equal(getFileKind("src/foo.test.ts"), "test");
  assert.equal(getFileKind("styles/app.scss"), "style");
  assert.equal(isDependencyFile("package.json"), true);
  assert.equal(isDependencyFile("src/foo.ts"), false);
});

test("getImpactRisk escalates on importers and dependency files", () => {
  assert.equal(getImpactRisk("package.json", 0, 0, 0).level, "high");
  assert.equal(getImpactRisk("src/util.ts", 12, 0, 0).level, "high");
  assert.equal(getImpactRisk("src/api/schema.ts", 0, 0, 0).level, "medium");
  assert.equal(getImpactRisk("src/leaf.ts", 0, 0, 0).level, "low");
});

test("getImpactRisk explains every verdict", () => {
  const high = getImpactRisk("src/util.ts", 12, 0, 0);
  assert.ok(high.reasons.some((r) => r.includes("12 files import this")));

  const changed = getImpactRisk("src/core.ts", 1, 0, 4);
  assert.equal(changed.level, "high");
  assert.ok(changed.reasons.some((r) => r.includes("4 other changed files")));

  const contract = getImpactRisk("src/api/schema.ts", 0, 0, 0);
  assert.equal(contract.level, "medium");
  assert.ok(contract.reasons.some((r) => r.includes("shared contract")));

  const leaf = getImpactRisk("src/leaf.ts", 0, 0, 0);
  assert.equal(leaf.level, "low");
  assert.deepEqual(leaf.reasons, ["no importers found in the scanned files"]);

  const single = getImpactRisk("src/thing.ts", 1, 0, 0);
  assert.ok(single.reasons.some((r) => r === "1 file imports this"), "singular grammar");
});

test("extractImportSpecifiers finds import/require/export/css references", () => {
  const specs = extractImportSpecifiers([
    "import { a } from './a';",
    "import type { T } from '../types';",
    "const b = require('./b');",
    "export { c } from './c';",
    "const d = await import('./d');",
    "@import 'theme.css';"
  ].join("\n"));

  assert.ok(specs.includes("./a"));
  assert.ok(specs.includes("../types"));
  assert.ok(specs.includes("./b"));
  assert.ok(specs.includes("./c"));
  assert.ok(specs.includes("./d"));
  assert.ok(specs.includes("theme.css"));
});

test("resolveImportSpecifier resolves relative specifiers against candidates", () => {
  const candidateSet = new Set(["src/a.ts", "src/util/index.ts"]);
  assert.equal(resolveImportSpecifier("src/foo.ts", "./a", candidateSet), "src/a.ts");
  assert.equal(resolveImportSpecifier("src/foo.ts", "./util", candidateSet), "src/util/index.ts");
  assert.equal(resolveImportSpecifier("src/foo.ts", "./missing", candidateSet), undefined);
  assert.equal(resolveImportSpecifier("src/foo.ts", "react", candidateSet), undefined);
});
