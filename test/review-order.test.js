const test = require("node:test");
const assert = require("node:assert/strict");

const { computeReviewOrder } = require("../src/impact");

// Minimal item shape used by computeReviewOrder.
function item(path, opts = {}) {
  return {
    path,
    risk: opts.risk || "low",
    importsChanged: opts.importsChanged || [],
    importedByChanged: opts.importedByChanged || [],
    importedByWorkspaceCount: opts.importedByWorkspaceCount || 0
  };
}

test("dependencies are ordered before the files that import them", () => {
  // app imports service; service imports util. Review util -> service -> app.
  const items = [
    item("app.ts", { importsChanged: ["service.ts"], importedByChanged: [] }),
    item("service.ts", { importsChanged: ["util.ts"], importedByChanged: ["app.ts"] }),
    item("util.ts", { importsChanged: [], importedByChanged: ["service.ts"] })
  ];

  assert.deepEqual(computeReviewOrder(items), ["util.ts", "service.ts", "app.ts"]);
});

test("independent files are ordered by risk, then depended-on count", () => {
  const items = [
    item("low.ts", { risk: "low" }),
    item("high.ts", { risk: "high" }),
    item("medium.ts", { risk: "medium" })
  ];
  assert.deepEqual(computeReviewOrder(items), ["high.ts", "medium.ts", "low.ts"]);
});

test("among ready files, the more depended-on comes first", () => {
  const items = [
    item("a.ts", { risk: "low", importedByChanged: ["x.ts"] }),
    item("b.ts", { risk: "low", importedByChanged: ["x.ts", "y.ts", "z.ts"] })
  ];
  assert.deepEqual(computeReviewOrder(items), ["b.ts", "a.ts"]);
});

test("cycles still produce a complete, stable order", () => {
  // a <-> b import each other; c is independent.
  const items = [
    item("a.ts", { importsChanged: ["b.ts"], importedByChanged: ["b.ts"] }),
    item("b.ts", { importsChanged: ["a.ts"], importedByChanged: ["a.ts"] }),
    item("c.ts", {})
  ];
  const order = computeReviewOrder(items);
  assert.equal(order.length, 3);
  assert.deepEqual(new Set(order), new Set(["a.ts", "b.ts", "c.ts"]));
});

test("empty input yields empty order", () => {
  assert.deepEqual(computeReviewOrder([]), []);
});
