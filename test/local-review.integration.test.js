const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createDiffRequest, runDiff } = require("../src/git");
const { parseUnifiedDiff } = require("../src/diff");

function initRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (args) => cp.execFileSync("git", args, { cwd: root, encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t.dev"]);
  git(["config", "user.name", "Test"]);
  git(["config", "commit.gpgsign", "false"]);
  return { root, git };
}

const pathsOf = (parsed) => parsed.files.map((f) => (f.newPath && f.newPath !== "/dev/null" ? f.newPath : f.oldPath));

test("local review works with NO commits — every file shows as added", async () => {
  const { root } = initRepo("different-local-nocommit-");
  try {
    fs.writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    fs.mkdirSync(path.join(root, "src"));
    fs.writeFileSync(path.join(root, "src", "b.ts"), "export const b = 2;\n");

    const request = await createDiffRequest(root, { kind: "local" });
    assert.equal(request.composite, true);
    assert.equal(request.hasHead, false);

    const parsed = parseUnifiedDiff(await runDiff(root, request));
    const files = pathsOf(parsed);
    assert.ok(files.includes("a.ts"));
    assert.ok(files.includes("src/b.ts"));
    for (const f of parsed.files) {
      assert.equal(f.status, "added");
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local review with commits includes tracked edits AND untracked files", async () => {
  const { root, git } = initRepo("different-local-commit-");
  try {
    fs.writeFileSync(path.join(root, "tracked.ts"), "export const v = 1;\n");
    git(["add", "."]);
    git(["commit", "-q", "-m", "baseline"]);

    // Edit the tracked file and add a brand-new untracked file.
    fs.writeFileSync(path.join(root, "tracked.ts"), "export const v = 2;\n");
    fs.writeFileSync(path.join(root, "fresh.ts"), "export const fresh = true;\n");

    const request = await createDiffRequest(root, { kind: "local" });
    assert.equal(request.hasHead, true);

    const parsed = parseUnifiedDiff(await runDiff(root, request));
    const byPath = Object.fromEntries(parsed.files.map((f) => [
      f.newPath && f.newPath !== "/dev/null" ? f.newPath : f.oldPath,
      f
    ]));

    assert.ok(byPath["tracked.ts"], "tracked edit is included");
    assert.equal(byPath["tracked.ts"].status, "modified");
    assert.ok(byPath["fresh.ts"], "untracked new file is included");
    assert.equal(byPath["fresh.ts"].status, "added");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("local review respects .gitignore (ignored files are not shown)", async () => {
  const { root } = initRepo("different-local-ignore-");
  try {
    fs.writeFileSync(path.join(root, ".gitignore"), "ignored.ts\n");
    fs.writeFileSync(path.join(root, "kept.ts"), "export const k = 1;\n");
    fs.writeFileSync(path.join(root, "ignored.ts"), "export const bad = 1;\n");

    const request = await createDiffRequest(root, { kind: "local" });
    const files = pathsOf(parseUnifiedDiff(await runDiff(root, request)));

    assert.ok(files.includes("kept.ts"));
    assert.ok(!files.includes("ignored.ts"), "gitignored file is excluded");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
