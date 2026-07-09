const test = require("node:test");
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  buildCoChangeAnalysis,
  parseGitLogNameOnly,
  buildCoChangeIndex,
  suggestCoChanges
} = require("../src/cochange");

const SEP = "\x1e";

test("parseGitLogNameOnly splits commits into file lists", () => {
  const log = [SEP, "src/a.ts", "src/b.ts", "", SEP, "src/a.ts", "src/c.ts", ""].join("\n");
  const commits = parseGitLogNameOnly(log);
  assert.deepEqual(commits, [["src/a.ts", "src/b.ts"], ["src/a.ts", "src/c.ts"]]);
});

test("buildCoChangeIndex counts files and pairs, skipping bulk commits", () => {
  const commits = [
    ["a", "b"],
    ["a", "b"],
    ["a", "c"],
    ["x", "y", "z", "w"] // bulk commit, skipped by maxFilesPerCommit
  ];
  const index = buildCoChangeIndex(commits, { maxFilesPerCommit: 3 });

  assert.equal(index.fileCounts.get("a"), 3);
  assert.equal(index.neighbors.get("a").get("b"), 2);
  assert.equal(index.neighbors.get("a").get("c"), 1);
  assert.equal(index.fileCounts.has("x"), false, "bulk commit excluded");
});

test("suggestCoChanges surfaces reliable partners not in the diff", () => {
  // a changed 4 times; b co-changed 3 of those (75%); c only once (25%).
  const commits = [
    ["a", "b"],
    ["a", "b"],
    ["a", "b"],
    ["a", "c"]
  ];
  const index = buildCoChangeIndex(commits);
  const suggestions = suggestCoChanges(index, ["a"], { minSupport: 3, minConfidence: 0.5 });

  assert.equal(suggestions.length, 1);
  assert.equal(suggestions[0].path, "b");
  assert.equal(suggestions[0].support, 3);
  assert.equal(suggestions[0].confidence, 0.75);
  assert.equal(suggestions[0].withChangedFile, "a");
});

test("suggestCoChanges excludes files already in the diff and low support", () => {
  const commits = [["a", "b"], ["a", "b"], ["a", "b"], ["a", "d"]];
  const index = buildCoChangeIndex(commits);

  // b is already changed -> not suggested; d has support 1 -> below threshold.
  const suggestions = suggestCoChanges(index, ["a", "b"], { minSupport: 3, minConfidence: 0.5 });
  assert.deepEqual(suggestions, []);
});

test("buildCoChangeAnalysis mines real git history end to end", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "different-cochange-"));
  const git = (args) => cp.execFileSync("git", args, { cwd: root, encoding: "utf8" });
  try {
    git(["init", "-q"]);
    git(["config", "user.email", "t@t.dev"]);
    git(["config", "user.name", "Test"]);
    git(["config", "commit.gpgsign", "false"]);

    const write = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), body);
    };

    // Four commits where model.ts and model.test.ts always move together.
    for (let i = 0; i < 4; i += 1) {
      write("src/model.ts", `export const v = ${i};\n`);
      write("src/model.test.ts", `// test ${i}\n`);
      git(["add", "."]);
      git(["commit", "-q", "-m", `change ${i}`]);
    }

    // Now a diff touches model.ts but NOT its test.
    const changedFiles = [{ oldPath: "src/model.ts", newPath: "src/model.ts", status: "modified" }];
    const result = await buildCoChangeAnalysis(root, changedFiles, { minSupport: 3, minConfidence: 0.5 });

    assert.ok(result.commitsAnalyzed >= 4);
    const testSuggestion = result.suggestions.find((s) => s.path === "src/model.test.ts");
    assert.ok(testSuggestion, "the companion test file is suggested");
    assert.equal(testSuggestion.withChangedFile, "src/model.ts");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
