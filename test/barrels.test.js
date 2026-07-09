const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractReexportSpecifiers,
  extractImportSpecifiers,
  buildBarrelAwareImporters,
  buildBarrelAwareDeps
} = require("../src/impact");

test("extractReexportSpecifiers finds only re-export forms", () => {
  const specs = extractReexportSpecifiers([
    "export * from './a';",
    "export * as ns from './b';",
    "export { c } from './c';",
    "export type { T } from './t';",
    "import { d } from './d';", // not a re-export
    "export const local = 1;" // not a re-export
  ].join("\n"));

  assert.deepEqual(new Set(specs), new Set(["./a", "./b", "./c", "./t"]));
});

test("extractImportSpecifiers still also captures re-exports (forward graph edges)", () => {
  const specs = extractImportSpecifiers("export { c } from './c';");
  assert.ok(specs.includes("./c"));
});

test("buildBarrelAwareImporters sees consumers through a barrel", () => {
  // app.ts imports the barrel; barrel re-exports Button. So app.ts depends on Button.
  const reverseGraph = new Map([
    ["ui/index.ts", new Set(["src/app.ts"])],
    ["ui/Button.tsx", new Set(["ui/index.ts"])]
  ]);
  const reexportGraph = new Map([["ui/index.ts", ["ui/Button.tsx"]]]);

  const importersOf = buildBarrelAwareImporters(reverseGraph, reexportGraph);
  const importers = importersOf("ui/Button.tsx");

  assert.ok(importers.has("src/app.ts"), "real consumer surfaces through the barrel");
  assert.ok(!importers.has("ui/index.ts"), "barrel itself is excluded as plumbing");
});

test("buildBarrelAwareImporters follows nested barrels up to the hop limit", () => {
  // app -> ui/index -> forms/index -> Field
  const reverseGraph = new Map([
    ["ui/index.ts", new Set(["src/app.ts"])],
    ["forms/index.ts", new Set(["ui/index.ts"])],
    ["forms/Field.tsx", new Set(["forms/index.ts"])]
  ]);
  const reexportGraph = new Map([
    ["ui/index.ts", ["forms/index.ts"]],
    ["forms/index.ts", ["forms/Field.tsx"]]
  ]);

  const importersOf = buildBarrelAwareImporters(reverseGraph, reexportGraph);
  assert.ok(importersOf("forms/Field.tsx").has("src/app.ts"));
});

test("buildBarrelAwareDeps pulls in modules forwarded by an imported barrel", () => {
  // app imports the barrel; barrel re-exports Button + Input.
  const importGraph = new Map([
    ["src/app.ts", ["ui/index.ts"]],
    ["ui/index.ts", ["ui/Button.tsx", "ui/Input.tsx"]]
  ]);
  const reexportGraph = new Map([["ui/index.ts", ["ui/Button.tsx", "ui/Input.tsx"]]]);

  const dependenciesOf = buildBarrelAwareDeps(importGraph, reexportGraph);
  const deps = dependenciesOf("src/app.ts");

  assert.ok(deps.has("ui/Button.tsx"));
  assert.ok(deps.has("ui/Input.tsx"));
  assert.ok(deps.has("ui/index.ts"), "the barrel itself remains a dependency");
});

test("barrel traversal terminates on cycles", () => {
  const reverseGraph = new Map([
    ["a.ts", new Set(["b.ts"])],
    ["b.ts", new Set(["a.ts"])]
  ]);
  const reexportGraph = new Map([
    ["a.ts", ["b.ts"]],
    ["b.ts", ["a.ts"]]
  ]);

  const importersOf = buildBarrelAwareImporters(reverseGraph, reexportGraph);
  assert.doesNotThrow(() => importersOf("a.ts"));

  const dependenciesOf = buildBarrelAwareDeps(importGraph_cycle(), reexportGraph);
  assert.doesNotThrow(() => dependenciesOf("a.ts"));
});

function importGraph_cycle() {
  return new Map([
    ["a.ts", ["b.ts"]],
    ["b.ts", ["a.ts"]]
  ]);
}
