# Diff-erent

A readable Git diff review surface for VS Code. Diff-erent renders your changes in a custom
webview built for *reviewing* — file list, per-hunk change summaries, inline token highlights,
and a static-analysis impact rail — instead of VS Code's plain side-by-side diff.

> Status: prototype (`v0.2-impact`). Run it from an Extension Development Host; there is no
> packaged install yet.

## Features

- **Working tree review** — open every uncommitted change in one scrollable surface.
- **Branch review** — diff your branch against a base ref (merge-base aware).
- **Single-file review** — open one changed file from Source Control or the editor.
- **Hunk summaries** — each hunk is labelled with what it touches: behavior, imports, exports,
  data, styles, UI, tests, type contracts, or dependencies.
- **Inline token diffing** — word-level highlights inside changed lines.
- **Impact rail** — a static import graph linking changed files to the workspace files that
  depend on them, with a low/medium/high risk hint and a "review these first" list.
- **Binary files** — detected and shown with a clear placeholder instead of an empty diff.
- **Filtering** — filter the file list by name or by status (modified / added / deleted / renamed).
- **Compact vs. expanded context**, refresh, "open file", and a "native diff" escape hatch.

## Run it locally

This is extension source, not an installed extension. To try it:

1. Open this folder in VS Code:
   ```sh
   code diff-erent
   ```
2. Press `F5` (or run the **Run Diff-erent Extension** launch config). This opens a second VS
   Code window — the Extension Development Host — where the extension is active.
3. In that window, open any Git repository.
4. Run **Diff-erent: Open Current Changes** from the Command Palette.

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

The impact view is a heuristic. It scans tracked source files and follows static `import`,
`export … from`, `require()`, dynamic `import()`, and CSS `@import` references to build a
dependency graph, then highlights which changed files are most depended-on.

It does **not** use TypeScript project references, bundler/path aliases, framework route graphs,
or compiler-level symbol analysis, so treat the risk hints as guidance rather than ground truth.
For large repositories the scan is capped at the first 2,200 tracked source files (noted in the
rail when truncated).

## Notes

Conflicted files during a merge appear in the **Diff-erent Changes** view; opening one shows the
working-tree version against `HEAD`, including conflict-marker edits where Git reports them.
