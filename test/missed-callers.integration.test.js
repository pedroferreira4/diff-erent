const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { parseUnifiedDiff } = require("../src/diff");
const { buildImpactAnalysis } = require("../src/impact");

function git(cwd, args) {
  return cp.execFileSync("git", args, { cwd, encoding: "utf8" });
}

function setupRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "different-callers-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "t@t.dev"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "commit.gpgsign", "false"]);

  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "api.ts"),
    "export function foo(a) {\n  return a;\n}\n\nexport function bar() {\n  return 2;\n}\n"
  );
  // caller.ts imports both foo and bar by name and will NOT be edited.
  fs.writeFileSync(
    path.join(root, "src", "caller.ts"),
    "import { foo, bar } from './api';\n\nexport const total = foo(1) + bar();\n"
  );
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "baseline"]);

  // Edit api.ts: remove `bar` entirely, change `foo`'s signature.
  fs.writeFileSync(
    path.join(root, "src", "api.ts"),
    "export function foo(a, b) {\n  return a + b;\n}\n"
  );
  return root;
}

test("buildImpactAnalysis flags callers of removed and changed exports", async () => {
  const root = setupRepo();
  try {
    const diffText = git(root, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--"]);
    const parsed = parseUnifiedDiff(diffText);
    const impact = await buildImpactAnalysis(root, parsed.files);

    const apiItem = impact.items.find((i) => i.path === "src/api.ts");
    assert.ok(apiItem, "api.ts is in the impact items");
    assert.ok(apiItem.missedCallers && apiItem.missedCallers.length > 0, "has missed callers");

    const bySymbol = Object.fromEntries(apiItem.missedCallers.map((m) => [m.symbol, m]));

    // `bar` was removed and caller.ts still imports it -> removed, caller flagged.
    assert.equal(bySymbol.bar.kind, "removed");
    assert.equal(bySymbol.bar.caller, "src/caller.ts");

    // `foo` signature changed while still exported -> changed.
    assert.equal(bySymbol.foo.kind, "changed");
    assert.equal(bySymbol.foo.caller, "src/caller.ts");

    // A removed export with a surviving caller forces high risk with a reason.
    assert.equal(apiItem.risk, "high");
    assert.ok(apiItem.riskReasons.some((r) => /caller\(s\) not updated/.test(r)));

    // Rollup is present.
    assert.ok(impact.missedCallers.some((m) => m.symbol === "bar" && m.file === "src/api.ts"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("no missed callers when the caller was also updated", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "different-callers2-"));
  try {
    git(root, ["init", "-q"]);
    git(root, ["config", "user.email", "t@t.dev"]);
    git(root, ["config", "user.name", "Test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "api.ts"), "export function foo(a) {\n  return a;\n}\n");
    fs.writeFileSync(path.join(root, "src", "caller.ts"), "import { foo } from './api';\nexport const x = foo(1);\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "baseline"]);

    // Change foo's signature AND update the caller in the same diff.
    fs.writeFileSync(path.join(root, "src", "api.ts"), "export function foo(a, b) {\n  return a + b;\n}\n");
    fs.writeFileSync(path.join(root, "src", "caller.ts"), "import { foo } from './api';\nexport const x = foo(1, 2);\n");

    const diffText = git(root, ["diff", "--no-color", "--no-ext-diff", "HEAD", "--"]);
    const impact = await buildImpactAnalysis(root, parseUnifiedDiff(diffText).files);

    assert.deepEqual(impact.missedCallers, [], "caller was updated in the same diff, so nothing is missed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
