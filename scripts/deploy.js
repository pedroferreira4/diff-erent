#!/usr/bin/env node
// Build the extension into a .vsix and install it into the local editor.
// Detects Cursor first, then VS Code. Run with: npm run deploy
const { execFileSync, execSync } = require("node:child_process");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const pkg = require(path.join(root, "package.json"));
const vsix = `${pkg.name}-${pkg.version}.vsix`;

function run(command, args) {
  execFileSync(command, args, { cwd: root, stdio: "inherit" });
}

function hasEditor(cli) {
  try {
    execSync(`${cli} --version`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const editor = ["cursor", "code"].find(hasEditor);
if (!editor) {
  console.error(
    "No editor CLI found. Install the 'cursor' or 'code' shell command\n" +
      "(in Cursor/VS Code: Command Palette -> \"Shell Command: Install 'cursor' command in PATH\"),\n" +
      `or install the prebuilt package manually: <editor> --install-extension ${vsix}`
  );
  process.exit(1);
}

console.log(`\n> Packaging ${vsix} ...`);
run("npx", ["--yes", "@vscode/vsce@latest", "package", "--no-dependencies"]);

console.log(`\n> Installing into ${editor} ...`);
run(editor, ["--install-extension", vsix, "--force"]);

console.log(`\nDone. Fully restart ${editor}, then run "Diff-erent: Open Current Changes".`);
