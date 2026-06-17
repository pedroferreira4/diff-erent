# Diff-erent

Diff-erent is a prototype VS Code extension for reading Git diffs in a more review-friendly layout.

## Why you do not see it in normal VS Code yet

This is an extension source folder. It is not installed into your regular VS Code window yet.

To see it, open this folder in VS Code and launch an **Extension Development Host**. That second VS Code window is where the extension appears.

## What it does

- Opens current working tree changes with `Diff-erent: Open Current Changes`.
- Opens branch changes against a base ref with `Diff-erent: Open Branch Diff Against Default Base`.
- Opens a single changed file with `Diff-erent: Open File Diff`.
- Adds a right-click action to Git Source Control file entries.
- Adds a `Diff-erent Changes` view under Source Control where clicking a file opens the Diff-erent single-file reader.
- Renders files, hunks, line numbers, additions, deletions, and inline token highlights in a custom webview.
- Labels hunks with lightweight change summaries like behavior, imports, data, styles, UI, tests, and type contracts.
- Shows an impact rail with static import relationships between changed files and unchanged workspace files.
- Adds file filtering, status filtering, compact context, refresh, open file, and native diff actions.

## Trigger behavior

Diff-erent does not replace VS Code's built-in Git left-click diff. VS Code's Git extension owns that default click.

Use one of these paths instead:

- Right-click a file in Source Control, then choose `Diff-erent: Open File Diff`.
- Open the `Diff-erent Changes` view in Source Control and click a file.
- Open a file in the editor and use the editor title action or command palette entry.
- Use `Diff-erent: Open Current Changes` for the whole working tree.

During a local merge or conflict resolution, `Diff-erent Changes` will list conflicted files from Git status. Opening one shows the working tree version against `HEAD`, including conflict marker edits when Git reports them in the file diff.

## Run locally

1. Open this folder in VS Code:

   ```sh
   code diff-erent
   ```

2. Press `F5` or run the `Run Diff-erent Extension` launch config.
3. In the Extension Development Host, open a Git repo.
4. Run `Diff-erent: Open Current Changes` from the Command Palette.

No install step is required for the current prototype.

## Settings

`different.defaultBaseRef` controls the base ref used by `Diff-erent: Open Branch Diff Against Default Base`.

Default: `main`

## Notes

This is a VS Code extension, not a Codex plugin. A Codex plugin could help generate review summaries later, but the editor UI needs to live in VS Code.

The impact view is heuristic. It scans tracked source files and follows static `import`, `export from`, `require`, dynamic `import()`, and CSS `@import` references. It does not yet use TypeScript project references, bundler aliases, framework route graphs, or compiler-level symbol analysis.
# diff-erent
