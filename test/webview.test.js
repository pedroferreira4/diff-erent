const test = require("node:test");
const assert = require("node:assert/strict");

const { getWebviewHtml } = require("../src/webview");

// The webview's browser script lives inside getWebviewHtml's template literal, so
// `node --check src/webview.js` only proves the FILE is valid — not that the
// script the browser actually receives (after the template literal is evaluated)
// is valid JS. A stray `\"` inside the template collapses to `"` and breaks the
// whole script silently. These tests check the EMITTED script, which is the gap
// that let exactly that bug ship.

function minimalState(overrides = {}) {
  return {
    title: "Diff-erent: main...HEAD",
    prototypeVersion: "v-test",
    rangeLabel: "abc -> HEAD",
    baseLabel: "main",
    mode: "branch",
    leftRef: "abc",
    rightRef: "HEAD",
    useWorkingTreeRight: false,
    files: [],
    totals: { files: 0, additions: 0, deletions: 0, hunks: 0 },
    impact: { items: [], edges: [], reviewOrder: [], missedCallers: [], truncated: false, note: "n" },
    coChange: { suggestions: [] },
    gitSummary: { repoName: "repo", branch: "main" },
    ...overrides
  };
}

function extractBrowserScript(html) {
  const start = html.indexOf("const vscode = acquireVsCodeApi();");
  const end = html.indexOf("</script>", start);
  assert.ok(start > 0 && end > start, "browser <script> block is present");
  return html.slice(start, end);
}

test("emitted webview browser script is syntactically valid JS", () => {
  const html = getWebviewHtml({}, minimalState());
  const body = extractBrowserScript(html);
  // new Function throws SyntaxError on a malformed emitted script (the failure
  // mode node --check on the source cannot catch).
  assert.doesNotThrow(() => new Function(body));
});

test("emitted script stays valid with the truncation branch's state", () => {
  // Guards the specific string that broke: the "no importers" truncation warning.
  const html = getWebviewHtml({}, minimalState({
    impact: { items: [], edges: [], reviewOrder: [], missedCallers: [], truncated: true, scannedFiles: 2200, totalSourceFiles: 9000, note: "n" }
  }));
  assert.doesNotThrow(() => new Function(extractBrowserScript(html)));
});

test("the embedded state JSON round-trips through the HTML", () => {
  const state = minimalState();
  const html = getWebviewHtml({}, state);
  const m = html.match(/<script[^>]*id="different-data"[^>]*>([\s\S]*?)<\/script>/);
  assert.ok(m, "different-data script present");
  const parsed = JSON.parse(m[1]);
  assert.equal(parsed.title, state.title);
});
