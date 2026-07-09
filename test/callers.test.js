const test = require("node:test");
const assert = require("node:assert/strict");

const {
  extractExportedNames,
  extractNamedImportBindings,
  changedExportNames,
  affectedExports
} = require("../src/callers");

test("extractExportedNames finds declaration and brace exports, not default", () => {
  const names = extractExportedNames([
    "export function foo() {}",
    "export const bar = 1;",
    "export class Baz {}",
    "export type T = string;",
    "export interface I {}",
    "export { a, b as c } from './x';",
    "export default function main() {}"
  ].join("\n"));

  assert.deepEqual(
    new Set(names),
    new Set(["foo", "bar", "Baz", "T", "I", "a", "c"])
  );
  assert.ok(!names.has("main"), "default export is not a named binding");
});

test("extractNamedImportBindings groups source names by specifier", () => {
  const bindings = extractNamedImportBindings([
    "import { foo, bar as baz } from './api';",
    "import type { T } from './types';",
    "import Default from './default';", // no braces -> ignored
    "import { extra } from './api';"
  ].join("\n"));

  assert.deepEqual(new Set(bindings.get("./api")), new Set(["foo", "bar", "extra"]));
  assert.deepEqual(new Set(bindings.get("./types")), new Set(["T"]));
  assert.equal(bindings.has("./default"), false);
});

test("extractNamedImportBindings uses the imported (source) name, not the alias", () => {
  const bindings = extractNamedImportBindings("import { original as local } from './m';");
  assert.ok(bindings.get("./m").has("original"));
  assert.ok(!bindings.get("./m").has("local"));
});

test("changedExportNames splits added vs removed export declarations", () => {
  const file = {
    hunks: [
      {
        lines: [
          { type: "delete", content: "export function gone() {}" },
          { type: "delete", content: "export function sig(a) {}" },
          { type: "add", content: "export function sig(a, b) {}" },
          { type: "add", content: "export const fresh = 1;" },
          { type: "context", content: "export const untouched = 2;" }
        ]
      }
    ]
  };

  const { removed, added } = changedExportNames(file);
  assert.deepEqual(new Set(removed), new Set(["gone", "sig"]));
  assert.deepEqual(new Set(added), new Set(["sig", "fresh"]));
});

test("affectedExports classifies removed vs signature-changed", () => {
  const file = {
    hunks: [
      {
        lines: [
          { type: "delete", content: "export function gone() {}" },
          { type: "delete", content: "export function sig(a) {}" },
          { type: "add", content: "export function sig(a, b) {}" }
        ]
      }
    ]
  };
  // `sig` still exists in the current file; `gone` does not.
  const currentExports = new Set(["sig"]);

  const affected = affectedExports(file, currentExports);
  const byName = Object.fromEntries(affected.map((a) => [a.name, a.kind]));

  assert.equal(byName.gone, "removed");
  assert.equal(byName.sig, "changed");
});

test("affectedExports ignores purely-added exports (no break risk)", () => {
  const file = {
    hunks: [{ lines: [{ type: "add", content: "export const brandNew = 1;" }] }]
  };
  assert.deepEqual(affectedExports(file, new Set(["brandNew"])), []);
});
