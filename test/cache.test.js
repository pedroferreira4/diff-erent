const test = require("node:test");
const assert = require("node:assert/strict");

const { getFileSpecifiers } = require("../src/impact");

// A fake io whose file content + mtime we control, counting reads.
function makeIo(initial) {
  const state = { content: initial.content, mtimeMs: initial.mtimeMs, reads: 0, stats: 0 };
  const io = {
    async stat() {
      state.stats += 1;
      return { isFile: () => true, size: state.content.length, mtimeMs: state.mtimeMs };
    },
    async readFile() {
      state.reads += 1;
      return state.content;
    }
  };
  return { io, state };
}

test("getFileSpecifiers caches by mtime and skips re-reading unchanged files", async () => {
  const cache = new Map();
  const { io, state } = makeIo({ content: "import { a } from './a';", mtimeMs: 100 });

  const first = await getFileSpecifiers("/repo", "src/x.ts", cache, io);
  assert.deepEqual(first.importSpecs, ["./a"]);
  assert.equal(state.reads, 1);

  // Same mtime -> cache hit -> no second read.
  const second = await getFileSpecifiers("/repo", "src/x.ts", cache, io);
  assert.deepEqual(second.importSpecs, ["./a"]);
  assert.equal(state.reads, 1, "unchanged file must not be re-read");
});

test("getFileSpecifiers re-reads when mtime changes", async () => {
  const cache = new Map();
  const { io, state } = makeIo({ content: "import { a } from './a';", mtimeMs: 100 });

  await getFileSpecifiers("/repo", "src/x.ts", cache, io);
  assert.equal(state.reads, 1);

  // File edited: new content + newer mtime.
  state.content = "import { b } from './b';";
  state.mtimeMs = 200;

  const updated = await getFileSpecifiers("/repo", "src/x.ts", cache, io);
  assert.deepEqual(updated.importSpecs, ["./b"]);
  assert.equal(state.reads, 2, "changed file must be re-read");
});

test("getFileSpecifiers returns null for oversized files without reading", async () => {
  const cache = new Map();
  const io = {
    async stat() {
      return { isFile: () => true, size: 2 * 1024 * 1024, mtimeMs: 1 };
    },
    async readFile() {
      throw new Error("should not read oversized file");
    }
  };

  assert.equal(await getFileSpecifiers("/repo", "big.ts", cache, io), null);
});
