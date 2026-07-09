# Diff-erent

A readable Git diff review surface for VS Code. Diff-erent renders your changes in a custom
webview built for *reviewing* — file list, per-hunk change summaries, inline token highlights,
and a static-analysis impact rail — instead of VS Code's plain side-by-side diff.

> Status: prototype (`v0.2-impact`). Install it locally with `npm run deploy`, or run it from an
> Extension Development Host while hacking on it. Not published to a marketplace.

## Features

- **Working tree review** — open every uncommitted change in one scrollable surface.
- **Branch review** — diff your branch against a base ref (merge-base aware).
- **Single-file review** — open one changed file from Source Control or the editor.
- **Hunk summaries** — each hunk is labelled with what it touches: behavior, imports, exports,
  data, styles, UI, tests, type contracts, or dependencies.
- **Inline token diffing** — word-level highlights inside changed lines.
- **Impact rail** — a static import graph linking changed files to the workspace files that
  depend on them. Resolves `tsconfig`/`jsconfig` path aliases, follows `export … from` re-export
  barrels, and gives each changed file a low/medium/high risk verdict that explains *why*, plus a
  "review these first" list.
- **Binary files** — detected and shown with a clear placeholder instead of an empty diff.
- **Filtering** — filter the file list by name or by status (modified / added / deleted / renamed).
- **Compact vs. expanded context**, refresh, "open file", and a "native diff" escape hatch.

## Install it (Cursor or VS Code)

Clone the repo and run one command — it builds the extension and installs it into your editor
(Cursor is detected first, then VS Code):

```sh
npm run deploy
```

Then **fully restart** your editor and run **Diff-erent: Open Current Changes** from the Command
Palette. The only requirement is the `cursor` or `code` shell command on your `PATH` (in the
editor: Command Palette → *Shell Command: Install 'cursor' command in PATH*).

To reinstall after pulling changes, just run `npm run deploy` again. Bump `version` in
`package.json` when you want the editor to treat it as an update rather than a reinstall.

## Develop it (live reload)

To hack on the extension itself, run it from an Extension Development Host instead of installing:

1. Open this folder in your editor.
2. Press `F5` (or run the **Run Diff-erent Extension** launch config) to open a second window
   with the extension active.
3. Open any Git repository there and run **Diff-erent: Open Current Changes**.

## Architecture

The analysis engine is deliberately decoupled from the VS Code shell — none of the engine modules
import `vscode`, so they run (and are tested) under plain Node without launching the editor:

| Module | Responsibility |
| --- | --- |
| `src/diff.js` | Parse unified `git diff` output into a file/hunk model. |
| `src/enrich.js` | Per-hunk change summaries, file tags, and weights. |
| `src/impact.js` | Import graph, barrel-following, and risk verdicts. |
| `src/aliases.js` | `tsconfig`/`jsconfig` path-alias resolution. |
| `src/git.js` | Git CLI wrapper and diff-request construction. |
| `src/webview.js` | The review UI (HTML/CSS/browser JS). |
| `src/util.js` | Shared path/string/classification helpers. |
| `src/extension.js` | Thin VS Code shell: commands, tree view, panels. |

```sh
npm test     # unit tests (node's built-in runner, no dependencies)
npm run check # syntax-check every module
```

## Commands

| Command | What it does |
| --- | --- |
| `Diff-erent: Open Current Changes` | Review the whole working tree against `HEAD`. |
| `Diff-erent: Open Branch Diff Against Default Base` | Review your branch against `different.defaultBaseRef`. |
| `Diff-erent: Open Branch Diff Against Ref…` | Prompt for a ref and review against it. |
| `Diff-erent: Open File Diff` | Review a single file (from the editor or Source Control). |
| `Diff-erent: Refresh Changes` | Refresh the `Diff-erent Changes` view. |

You can also:

- Right-click a file in **Source Control** → **Diff-erent: Open File Diff**.
- Open the **Diff-erent Changes** view under Source Control and click any file.
- Use the editor title-bar action while a file is open.

Diff-erent does **not** override VS Code's built-in left-click diff — the Git extension owns that.
Use one of the entry points above instead.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `different.defaultBaseRef` | `main` | Base ref used by **Open Branch Diff Against Default Base**. |

## How the impact rail works

The impact view is a heuristic, but a fairly careful one. It scans tracked source files and
follows static `import`, `export … from`, `require()`, dynamic `import()`, and CSS `@import`
references to build a dependency graph, then highlights which changed files are most depended-on.

- **Alias resolution** — relative imports are resolved directly, and non-relative imports are
  resolved through `tsconfig`/`jsconfig` `paths` + `baseUrl` (one level of `extends` is merged).
  Repos without such a config fall back to a looser name-based match.
- **Barrel-following** — `export … from` re-exports are treated as barrels, so a file that imports
  a changed module *through* an `index.ts` still shows up in that module's blast radius (up to two
  hops, cycle-safe).
- **Explained risk** — each changed file gets a low/medium/high verdict with the reasons shown
  inline (e.g. "12 files import this", "depends on 2 other changed files").
- **Incremental cache** — extracted imports are cached per repo by file mtime, so refreshing only
  re-reads files that actually changed.
- **Truncation is loud** — for large repositories the scan is capped at the first 2,200 tracked
  source files. When that happens the rail shows a warning banner, and any "no importers" verdict
  is flagged as possibly incomplete rather than presented as a confident zero.

It does **not** use TypeScript project references, bundler graphs, framework route graphs, or
compiler-level symbol analysis, so treat the verdicts as guidance rather than ground truth. Alias
`baseUrl` is currently resolved as if the config sits at the repo root, so per-package configs in a
monorepo are not handled yet.

## Notes

Conflicted files during a merge appear in the **Diff-erent Changes** view; opening one shows the
working-tree version against `HEAD`, including conflict-marker edits where Git reports them.
