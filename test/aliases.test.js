const test = require("node:test");
const assert = require("node:assert/strict");

const { parseJsonc, loadAliasConfig, aliasBaseCandidates } = require("../src/aliases");
const { resolveAliasImport } = require("../src/impact");

test("parseJsonc tolerates comments and trailing commas", () => {
  const parsed = parseJsonc([
    "{",
    "  // line comment",
    "  \"compilerOptions\": {",
    "    /* block */ \"baseUrl\": \".\",",
    "    \"paths\": { \"@/*\": [\"src/*\"], },",
    "  },",
    "}"
  ].join("\n"));

  assert.equal(parsed.compilerOptions.baseUrl, ".");
  assert.deepEqual(parsed.compilerOptions.paths["@/*"], ["src/*"]);
});

test("parseJsonc keeps // inside string values intact", () => {
  const parsed = parseJsonc('{ "url": "https://example.com/x" }');
  assert.equal(parsed.url, "https://example.com/x");
});

test("loadAliasConfig reads tsconfig paths with injected reader", async () => {
  const fakeFiles = {
    "/repo/tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "@ui/*": ["src/components/*"] } }
    })
  };
  const readFile = async (p) => {
    if (fakeFiles[p]) return fakeFiles[p];
    throw new Error("ENOENT");
  };

  const config = await loadAliasConfig("/repo", readFile);
  assert.equal(config.baseUrl, "");
  assert.deepEqual(config.paths["@/*"], ["src/*"]);
});

test("loadAliasConfig merges an extends chain (child wins)", async () => {
  const fakeFiles = {
    "/repo/tsconfig.base.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "@shared/*": ["shared/*"] } }
    }),
    "/repo/tsconfig.json": JSON.stringify({
      extends: "./tsconfig.base.json",
      compilerOptions: { paths: { "@/*": ["app/*"] } }
    })
  };
  const readFile = async (p) => {
    if (fakeFiles[p]) return fakeFiles[p];
    throw new Error("ENOENT");
  };

  const config = await loadAliasConfig("/repo", readFile);
  assert.deepEqual(config.paths["@/*"], ["app/*"]); // child override
  assert.deepEqual(config.paths["@shared/*"], ["shared/*"]); // inherited
});

test("loadAliasConfig returns null when no config exists", async () => {
  const readFile = async () => {
    throw new Error("ENOENT");
  };
  assert.equal(await loadAliasConfig("/repo", readFile), null);
});

test("aliasBaseCandidates maps wildcard patterns to base paths", () => {
  const config = { baseUrl: "", paths: { "@/*": ["src/*"], "@ui/*": ["src/components/*"] } };
  assert.ok(aliasBaseCandidates("@/foo/bar", config).includes("src/foo/bar"));
  assert.ok(aliasBaseCandidates("@ui/Button", config).includes("src/components/Button"));
});

test("aliasBaseCandidates honours baseUrl for bare non-relative imports", () => {
  const config = { baseUrl: "src", paths: {} };
  assert.ok(aliasBaseCandidates("components/Button", config).includes("src/components/Button"));
});

test("resolveAliasImport resolves an alias onto a real tracked file", () => {
  const config = { baseUrl: "", paths: { "@/*": ["src/*"] } };
  const candidateSet = new Set(["src/foo.ts", "src/widgets/index.tsx"]);

  assert.equal(resolveAliasImport("@/foo", config, candidateSet), "src/foo.ts");
  assert.equal(resolveAliasImport("@/widgets", config, candidateSet), "src/widgets/index.tsx");
  assert.equal(resolveAliasImport("@/missing", config, candidateSet), undefined);
});

test("resolveAliasImport ignores relative specifiers and node packages", () => {
  const config = { baseUrl: "", paths: { "@/*": ["src/*"] } };
  const candidateSet = new Set(["src/foo.ts"]);

  assert.equal(resolveAliasImport("./foo", config, candidateSet), undefined);
  assert.equal(resolveAliasImport("react", config, candidateSet), undefined);
  assert.equal(resolveAliasImport("@/foo", null, candidateSet), undefined);
});
