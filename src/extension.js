const cp = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const vscode = require("vscode");

const ORIGINAL_SCHEME = "diff-erent-original";
const EMPTY_SCHEME = "diff-erent-empty";
const PROTOTYPE_VERSION = "v0.2-impact";
const SOURCE_EXTENSIONS = [
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".mjs",
  ".mts",
  ".cjs",
  ".cts",
  ".vue",
  ".svelte",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".pcss",
  ".json",
  ".graphql",
  ".gql"
];

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const originalProvider = new GitContentProvider();
  const emptyProvider = { provideTextDocumentContent: () => "" };
  const changesProvider = new ChangesTreeProvider();

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(ORIGINAL_SCHEME, originalProvider),
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, emptyProvider),
    vscode.window.registerTreeDataProvider("different.changesView", changesProvider),
    vscode.commands.registerCommand("different.openWorkingTree", () => openDiffLens(context, { kind: "workingTree" })),
    vscode.commands.registerCommand("different.openAgainstDefaultBase", () => {
      const baseRef = vscode.workspace.getConfiguration("different").get("defaultBaseRef", "main");
      return openDiffLens(context, { kind: "branch", baseRef });
    }),
    vscode.commands.registerCommand("different.openAgainstRef", async () => {
      const baseRef = await vscode.window.showInputBox({
        title: "Open Diff-erent Against Ref",
        prompt: "Git ref to compare against",
        value: vscode.workspace.getConfiguration("different").get("defaultBaseRef", "main"),
        validateInput(value) {
          return value.trim() ? undefined : "Enter a Git ref.";
        }
      });

      if (!baseRef) {
        return;
      }

      return openDiffLens(context, { kind: "branch", baseRef: baseRef.trim() });
    }),
    vscode.commands.registerCommand("different.openResource", (...args) => openResourceDiff(context, args)),
    vscode.commands.registerCommand("different.openFileDiff", (change) => openFileDiff(context, change)),
    vscode.commands.registerCommand("different.refreshChanges", () => changesProvider.refresh()),
    vscode.workspace.onDidSaveTextDocument(() => changesProvider.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changesProvider.refresh())
  );
}

function deactivate() {}

class GitContentProvider {
  /**
   * @param {vscode.Uri} uri
   * @returns {Thenable<string>}
   */
  provideTextDocumentContent(uri) {
    const payload = parseProviderPayload(uri);
    if (!payload || payload.empty) {
      return Promise.resolve("");
    }

    return execGit(payload.repoRoot, ["show", `${payload.ref}:${payload.filePath}`]).catch((error) => {
      return `Unable to load ${payload.ref}:${payload.filePath}\n\n${error.message}`;
    });
  }
}

class ChangesTreeProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(item) {
    return item;
  }

  async getChildren() {
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.length === 0) {
      return [new MessageTreeItem("Open a Git workspace to use Diff-erent.")];
    }

    const items = [];
    for (const folder of folders) {
      try {
        const repoRoot = await getRepositoryRoot(folder.uri.fsPath);
        const changes = await getWorkspaceChanges(repoRoot);
        for (const change of changes) {
          items.push(new ChangeTreeItem({
            ...change,
            repoRoot,
            repoName: path.basename(repoRoot)
          }));
        }
      } catch {
        // Non-Git workspace folders should not make the entire view fail.
      }
    }

    return items.length > 0 ? items : [new MessageTreeItem("No working tree changes.")];
  }
}

class ChangeTreeItem extends vscode.TreeItem {
  constructor(change) {
    super(path.basename(change.filePath), vscode.TreeItemCollapsibleState.None);
    const directory = path.dirname(change.filePath);
    this.change = change;
    this.description = `${change.statusLabel} · ${directory === "." ? change.repoName : directory}`;
    this.tooltip = `${change.repoName}: ${change.filePath}`;
    this.resourceUri = vscode.Uri.file(path.join(change.repoRoot, change.filePath));
    this.contextValue = "differentChange";
    this.iconPath = new vscode.ThemeIcon(getStatusIcon(change.status));
    this.command = {
      command: "different.openFileDiff",
      title: "Open with Diff-erent",
      arguments: [change]
    };
  }
}

class MessageTreeItem extends vscode.TreeItem {
  constructor(message) {
    super(message, vscode.TreeItemCollapsibleState.None);
    this.contextValue = "differentMessage";
    this.iconPath = new vscode.ThemeIcon("info");
  }
}

async function openResourceDiff(context, args) {
  const selection = await resolveFileSelection(args);
  if (!selection) {
    vscode.window.showWarningMessage("Diff-erent could not determine which file to open.");
    return;
  }

  await openDiffLens(context, {
    kind: "file",
    repoRoot: selection.repoRoot,
    filePath: selection.filePath,
    status: selection.status
  });
}

async function openFileDiff(context, change) {
  const selection = await resolveFileSelection([change]);
  if (!selection) {
    vscode.window.showWarningMessage("Diff-erent could not determine which file to open.");
    return;
  }

  await openDiffLens(context, {
    kind: "file",
    repoRoot: selection.repoRoot,
    filePath: selection.filePath,
    status: selection.status
  });
}

async function resolveFileSelection(args) {
  const directChange = findDirectChange(args);
  if (directChange) {
    return directChange;
  }

  const uri = findUri(args) || (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
  if (!uri || uri.scheme !== "file") {
    return undefined;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return undefined;
  }

  const repoRoot = await getRepositoryRoot(workspaceFolder.uri.fsPath);
  return {
    repoRoot,
    filePath: toPosixPath(path.relative(repoRoot, uri.fsPath)),
    status: "modified"
  };
}

function findDirectChange(args) {
  for (const arg of flattenArgs(args)) {
    if (arg && typeof arg.repoRoot === "string" && typeof arg.filePath === "string") {
      return {
        repoRoot: arg.repoRoot,
        filePath: toPosixPath(arg.filePath),
        status: arg.status || "modified"
      };
    }
  }

  return undefined;
}

function findUri(args) {
  for (const arg of flattenArgs(args)) {
    if (isUri(arg)) {
      return arg;
    }

    if (arg && isUri(arg.resourceUri)) {
      return arg.resourceUri;
    }

    if (arg && isUri(arg.uri)) {
      return arg.uri;
    }

    if (arg && arg.resource && isUri(arg.resource.uri)) {
      return arg.resource.uri;
    }

    if (arg && arg.resource && isUri(arg.resource.resourceUri)) {
      return arg.resource.resourceUri;
    }
  }

  return undefined;
}

function flattenArgs(args) {
  const flattened = [];
  for (const arg of args || []) {
    if (Array.isArray(arg)) {
      flattened.push(...flattenArgs(arg));
    } else {
      flattened.push(arg);
    }
  }
  return flattened;
}

function isUri(value) {
  return value && typeof value.scheme === "string" && typeof value.fsPath === "string";
}

/**
 * @param {vscode.ExtensionContext} context
 * @param {{ kind: "workingTree" } | { kind: "branch", baseRef: string } | { kind: "file", repoRoot?: string, filePath: string, status?: string }} request
 */
async function openDiffLens(context, request) {
  const workspaceFolder = request.repoRoot ? undefined : await pickWorkspaceFolder();
  if (!request.repoRoot && !workspaceFolder) {
    return;
  }

  try {
    const repoRoot = request.repoRoot || (await getRepositoryRoot(workspaceFolder.uri.fsPath));
    const diffRequest = await createDiffRequest(repoRoot, request);
    const diffText = await execGit(repoRoot, diffRequest.args, { acceptExitCodes: diffRequest.acceptExitCodes });
    const parsed = parseUnifiedDiff(diffText);
    enrichParsedDiff(parsed);
    const impact = await buildImpactAnalysis(repoRoot, parsed.files);
    const gitSummary = await getGitSummary(repoRoot, diffRequest);

    const panel = vscode.window.createWebviewPanel(
      "different",
      diffRequest.title,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );

    const state = {
      repoRoot,
      title: diffRequest.title,
      prototypeVersion: PROTOTYPE_VERSION,
      mode: diffRequest.mode,
      rangeLabel: diffRequest.rangeLabel,
      baseLabel: diffRequest.baseLabel,
      leftRef: diffRequest.leftRef,
      rightRef: diffRequest.rightRef,
      useWorkingTreeRight: diffRequest.useWorkingTreeRight,
      generatedAt: new Date().toISOString(),
      files: parsed.files,
      totals: parsed.totals,
      impact,
      gitSummary
    };
    const session = { state };

    panel.webview.html = getWebviewHtml(panel.webview, state);
    panel.webview.onDidReceiveMessage((message) => handleWebviewMessage(panel, session, request, message));
  } catch (error) {
    vscode.window.showErrorMessage(`Diff-erent failed: ${error.message}`);
  }
}

/**
 * @param {vscode.WebviewPanel} panel
 * @param {{ state: any }} session
 * @param {{ kind: "workingTree" } | { kind: "branch", baseRef: string }} request
 * @param {{ type?: string, filePath?: string, oldPath?: string, newPath?: string }} message
 */
async function handleWebviewMessage(panel, session, request, message) {
  if (!message || typeof message.type !== "string") {
    return;
  }

  const state = session.state;

  if (message.type === "refresh") {
    try {
      const diffRequest = await createDiffRequest(state.repoRoot, request);
      const diffText = await execGit(state.repoRoot, diffRequest.args, { acceptExitCodes: diffRequest.acceptExitCodes });
      const parsed = parseUnifiedDiff(diffText);
      enrichParsedDiff(parsed);
      const impact = await buildImpactAnalysis(state.repoRoot, parsed.files);
      const gitSummary = await getGitSummary(state.repoRoot, diffRequest);
      const nextState = {
        ...state,
        title: diffRequest.title,
        prototypeVersion: PROTOTYPE_VERSION,
        mode: diffRequest.mode,
        rangeLabel: diffRequest.rangeLabel,
        baseLabel: diffRequest.baseLabel,
        leftRef: diffRequest.leftRef,
        rightRef: diffRequest.rightRef,
        useWorkingTreeRight: diffRequest.useWorkingTreeRight,
        generatedAt: new Date().toISOString(),
        files: parsed.files,
        totals: parsed.totals,
        impact,
        gitSummary
      };
      session.state = nextState;
      panel.title = diffRequest.title;
      panel.webview.html = getWebviewHtml(panel.webview, nextState);
    } catch (error) {
      vscode.window.showErrorMessage(`Diff-erent refresh failed: ${error.message}`);
    }
    return;
  }

  if (message.type === "openFile") {
    await openWorkspaceFile(state.repoRoot, message.newPath || message.filePath);
    return;
  }

  if (message.type === "openNativeDiff") {
    await openNativeDiff(state, message.oldPath, message.newPath);
  }
}

async function pickWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders || [];

  if (folders.length === 0) {
    vscode.window.showWarningMessage("Open a Git workspace before using Diff-erent.");
    return undefined;
  }

  if (folders.length === 1) {
    return folders[0];
  }

  const picked = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder
    })),
    {
      title: "Select workspace folder for Diff-erent"
    }
  );

  return picked && picked.folder;
}

async function getRepositoryRoot(cwd) {
  const root = await execGit(cwd, ["rev-parse", "--show-toplevel"]);
  return root.trim();
}

async function getWorkspaceChanges(repoRoot) {
  const statusText = await execGit(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  return statusText
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseStatusLine)
    .filter(Boolean);
}

function parseStatusLine(line) {
  if (line.length < 4) {
    return undefined;
  }

  const status = line.slice(0, 2);
  const rawPath = line.slice(3);
  const renamedPath = rawPath.includes(" -> ") ? rawPath.split(" -> ").pop() : rawPath;
  const filePath = normalizeStatusPath(renamedPath);

  if (!filePath) {
    return undefined;
  }

  return {
    filePath,
    status,
    statusLabel: getStatusLabel(status)
  };
}

function normalizeStatusPath(rawPath) {
  return toPosixPath(unquoteGitPath(rawPath.trim()));
}

function getStatusLabel(status) {
  if (status === "??") {
    return "untracked";
  }
  if (status.includes("U")) {
    return "conflict";
  }
  if (status.includes("A")) {
    return "added";
  }
  if (status.includes("D")) {
    return "deleted";
  }
  if (status.includes("R")) {
    return "renamed";
  }
  if (status.includes("C")) {
    return "copied";
  }
  return "modified";
}

function getStatusIcon(status) {
  const label = getStatusLabel(status);
  if (label === "added" || label === "untracked") {
    return "diff-added";
  }
  if (label === "deleted") {
    return "diff-removed";
  }
  if (label === "renamed" || label === "copied") {
    return "diff-renamed";
  }
  if (label === "conflict") {
    return "warning";
  }
  return "diff-modified";
}

async function isTrackedFile(repoRoot, filePath) {
  try {
    await execGit(repoRoot, ["ls-files", "--error-unmatch", "--", filePath]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} repoRoot
 * @param {{ kind: "workingTree" } | { kind: "branch", baseRef: string } | { kind: "file", repoRoot?: string, filePath: string, status?: string }} request
 */
async function createDiffRequest(repoRoot, request) {
  if (request.kind === "file") {
    const filePath = toPosixPath(request.filePath);
    const tracked = request.status === "??" ? false : await isTrackedFile(repoRoot, filePath);

    if (!tracked) {
      return {
        mode: "file",
        title: `Diff-erent: ${path.basename(filePath)}`,
        rangeLabel: `untracked -> ${filePath}`,
        baseLabel: "untracked",
        leftRef: null,
        rightRef: null,
        useWorkingTreeRight: true,
        acceptExitCodes: [0, 1],
        args: [
          "diff",
          "--no-color",
          "--no-ext-diff",
          "--no-index",
          "--src-prefix=a/",
          "--dst-prefix=b/",
          "/dev/null",
          filePath
        ]
      };
    }

    return {
      mode: "file",
      title: `Diff-erent: ${path.basename(filePath)}`,
      rangeLabel: `HEAD -> working tree / ${filePath}`,
      baseLabel: "HEAD",
      leftRef: "HEAD",
      rightRef: null,
      useWorkingTreeRight: true,
      args: [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "HEAD",
        "--",
        filePath
      ]
    };
  }

  if (request.kind === "workingTree") {
    return {
      mode: "workingTree",
      title: "Diff-erent: Current Changes",
      rangeLabel: "HEAD -> working tree",
      baseLabel: "HEAD",
      leftRef: "HEAD",
      rightRef: null,
      useWorkingTreeRight: true,
      args: [
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--find-renames",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "HEAD",
        "--"
      ]
    };
  }

  await execGit(repoRoot, ["rev-parse", "--verify", `${request.baseRef}^{commit}`]);
  const mergeBase = (await execGit(repoRoot, ["merge-base", request.baseRef, "HEAD"])).trim();

  return {
    mode: "branch",
    title: `Diff-erent: ${request.baseRef}...HEAD`,
    rangeLabel: `${shortRef(mergeBase)} -> HEAD`,
    baseLabel: request.baseRef,
    leftRef: mergeBase,
    rightRef: "HEAD",
    useWorkingTreeRight: false,
    args: [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      `${request.baseRef}...HEAD`,
      "--"
    ]
  };
}

async function getGitSummary(repoRoot, diffRequest) {
  try {
    const status = await execGit(repoRoot, ["status", "--short", "--branch"]);
    const branch = status.split(/\r?\n/)[0] || "";
    return {
      branch: branch.replace(/^##\s*/, ""),
      repoName: path.basename(repoRoot),
      repoRoot,
      rangeLabel: diffRequest.rangeLabel
    };
  } catch {
    return {
      branch: "",
      repoName: path.basename(repoRoot),
      repoRoot,
      rangeLabel: diffRequest.rangeLabel
    };
  }
}

async function openWorkspaceFile(repoRoot, filePath) {
  if (!filePath || filePath === "/dev/null") {
    vscode.window.showWarningMessage("This file does not exist in the working tree.");
    return;
  }

  const uri = vscode.Uri.file(path.join(repoRoot, filePath));
  try {
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: false });
  } catch (error) {
    vscode.window.showWarningMessage(`Unable to open ${filePath}: ${error.message}`);
  }
}

async function openNativeDiff(state, oldPath, newPath) {
  const fileLabel = newPath && newPath !== "/dev/null" ? newPath : oldPath;
  if (!fileLabel) {
    return;
  }

  const leftEmpty = !oldPath || oldPath === "/dev/null";
  const rightEmpty = !newPath || newPath === "/dev/null";
  const left = leftEmpty
    ? makeEmptyUri(`left/${fileLabel}`)
    : makeGitUri(state.repoRoot, state.leftRef, oldPath);

  let right;
  if (rightEmpty) {
    right = makeEmptyUri(`right/${fileLabel}`);
  } else if (state.useWorkingTreeRight) {
    right = vscode.Uri.file(path.join(state.repoRoot, newPath));
  } else {
    right = makeGitUri(state.repoRoot, state.rightRef || "HEAD", newPath);
  }

  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${fileLabel} (${state.rangeLabel})`,
    { preview: false }
  );
}

function makeGitUri(repoRoot, ref, filePath) {
  return vscode.Uri.from({
    scheme: ORIGINAL_SCHEME,
    authority: "git",
    path: `/${path.basename(filePath)}`,
    query: encodeURIComponent(JSON.stringify({ repoRoot, ref, filePath }))
  });
}

function makeEmptyUri(label) {
  return vscode.Uri.from({
    scheme: EMPTY_SCHEME,
    authority: "empty",
    path: `/${label.replace(/\\/g, "/")}`
  });
}

function parseProviderPayload(uri) {
  try {
    return JSON.parse(decodeURIComponent(uri.query));
  } catch {
    return undefined;
  }
}

function execGit(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    cp.execFile(
      "git",
      args,
      {
        cwd,
        maxBuffer: 50 * 1024 * 1024
      },
      (error, stdout, stderr) => {
        const acceptExitCodes = options.acceptExitCodes || [0];
        if (error && !acceptExitCodes.includes(error.code)) {
          const detail = stderr.toString().trim() || error.message;
          reject(new Error(detail));
          return;
        }

        resolve(stdout.toString());
      }
    );
  });
}

function parseUnifiedDiff(diffText) {
  const lines = diffText.split(/\r?\n/);
  /** @type {Array<any>} */
  const files = [];
  let file = null;
  let hunk = null;

  for (const rawLine of lines) {
    if (rawLine.startsWith("diff --git ")) {
      file = createFile(rawLine);
      hunk = null;
      files.push(file);
      continue;
    }

    if (!file) {
      continue;
    }

    if (rawLine.startsWith("new file mode ")) {
      file.status = "added";
      continue;
    }

    if (rawLine.startsWith("deleted file mode ")) {
      file.status = "deleted";
      continue;
    }

    if (rawLine.startsWith("similarity index ")) {
      file.status = "renamed";
      continue;
    }

    if (rawLine.startsWith("rename from ")) {
      file.oldPath = rawLine.slice("rename from ".length);
      file.status = "renamed";
      continue;
    }

    if (rawLine.startsWith("rename to ")) {
      file.newPath = rawLine.slice("rename to ".length);
      file.status = "renamed";
      continue;
    }

    if (rawLine.startsWith("--- ")) {
      const oldPath = normalizeDiffPath(rawLine.slice(4));
      file.oldPath = oldPath;
      if (oldPath === "/dev/null") {
        file.status = "added";
      }
      continue;
    }

    if (rawLine.startsWith("+++ ")) {
      const newPath = normalizeDiffPath(rawLine.slice(4));
      file.newPath = newPath;
      if (newPath === "/dev/null") {
        file.status = "deleted";
      }
      continue;
    }

    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (hunkMatch) {
      hunk = {
        header: rawLine,
        oldStart: Number(hunkMatch[1]),
        oldLines: Number(hunkMatch[2] || "1"),
        newStart: Number(hunkMatch[3]),
        newLines: Number(hunkMatch[4] || "1"),
        section: hunkMatch[5] || "",
        lines: []
      };
      hunk.oldCursor = hunk.oldStart;
      hunk.newCursor = hunk.newStart;
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) {
      continue;
    }

    addHunkLine(hunk, rawLine);
  }

  for (const nextFile of files) {
    nextFile.additions = 0;
    nextFile.deletions = 0;
    nextFile.hunks.forEach((nextHunk) => {
      delete nextHunk.oldCursor;
      delete nextHunk.newCursor;
      nextHunk.lines.forEach((line) => {
        if (line.type === "add") {
          nextFile.additions += 1;
        }
        if (line.type === "delete") {
          nextFile.deletions += 1;
        }
      });
    });

    if (nextFile.status === "modified" && nextFile.oldPath !== nextFile.newPath) {
      nextFile.status = "renamed";
    }
  }

  const totals = files.reduce(
    (acc, nextFile) => {
      acc.files += 1;
      acc.additions += nextFile.additions;
      acc.deletions += nextFile.deletions;
      acc.hunks += nextFile.hunks.length;
      acc[nextFile.status] = (acc[nextFile.status] || 0) + 1;
      return acc;
    },
    {
      files: 0,
      additions: 0,
      deletions: 0,
      hunks: 0,
      added: 0,
      deleted: 0,
      modified: 0,
      renamed: 0
    }
  );

  return { files, totals };
}

function enrichParsedDiff(parsed) {
  for (const file of parsed.files) {
    const filePath = getDiffFilePath(file);
    file.kind = getFileKind(filePath);

    for (const hunk of file.hunks) {
      hunk.insight = summarizeHunk(file, hunk);
    }

    file.tags = getFileTags(file, filePath);
    file.weight = getFileWeight(file);
  }

  parsed.totals.weight = parsed.files.reduce((sum, file) => sum + file.weight, 0);
}

async function buildImpactAnalysis(repoRoot, files) {
  const changedPaths = files
    .map(getDiffFilePath)
    .filter((filePath) => filePath && filePath !== "/dev/null" && isLikelySourceFile(filePath));
  const uniqueChangedPaths = [...new Set(changedPaths)];

  if (uniqueChangedPaths.length === 0) {
    return {
      scannedFiles: 0,
      relationships: 0,
      items: [],
      edges: [],
      note: "No source files changed."
    };
  }

  try {
    const trackedFiles = (await execGit(repoRoot, ["ls-files"]))
      .split(/\r?\n/)
      .filter(Boolean)
      .map(toPosixPath)
      .filter(isLikelySourceFile);
    const candidates = trackedFiles.slice(0, 2200);
    const candidateSet = new Set([...candidates, ...uniqueChangedPaths]);
    const importGraph = new Map();
    const reverseGraph = new Map();

    for (const filePath of candidates) {
      const imports = await readWorkspaceImports(repoRoot, filePath, candidateSet, uniqueChangedPaths);
      importGraph.set(filePath, imports);

      for (const importedFile of imports) {
        if (!reverseGraph.has(importedFile)) {
          reverseGraph.set(importedFile, new Set());
        }
        reverseGraph.get(importedFile).add(filePath);
      }
    }

    const changedSet = new Set(uniqueChangedPaths);
    const items = uniqueChangedPaths.map((filePath) => {
      const importedBy = [...(reverseGraph.get(filePath) || [])].filter((importer) => importer !== filePath);
      const importsChanged = (importGraph.get(filePath) || []).filter((target) => changedSet.has(target) && target !== filePath);
      const changedImporters = importedBy.filter((importer) => changedSet.has(importer));
      const workspaceImporters = importedBy.filter((importer) => !changedSet.has(importer));
      const file = files.find((nextFile) => getDiffFilePath(nextFile) === filePath);

      return {
        path: filePath,
        kind: getFileKind(filePath),
        status: file ? file.status : "modified",
        risk: getImpactRisk(filePath, workspaceImporters.length, importsChanged.length, changedImporters.length),
        importsChanged: importsChanged.slice(0, 8),
        importedByChanged: changedImporters.slice(0, 8),
        importedByWorkspace: workspaceImporters.slice(0, 10),
        importedByWorkspaceCount: workspaceImporters.length
      };
    });

    const edges = [];
    for (const item of items) {
      for (const target of item.importsChanged) {
        edges.push({ from: item.path, to: target, type: "imports" });
      }
      for (const importer of item.importedByChanged) {
        edges.push({ from: importer, to: item.path, type: "imports" });
      }
    }

    return {
      scannedFiles: candidates.length,
      relationships: edges.length + items.reduce((sum, item) => sum + item.importedByWorkspaceCount, 0),
      truncated: trackedFiles.length > candidates.length,
      items,
      edges,
      note: trackedFiles.length > candidates.length
        ? `Scanned the first ${candidates.length} tracked source files.`
        : "Import relationships are based on static import, export, require, and CSS import references."
    };
  } catch (error) {
    return {
      scannedFiles: 0,
      relationships: 0,
      items: [],
      edges: [],
      note: `Impact scan unavailable: ${error.message}`
    };
  }
}

async function readWorkspaceImports(repoRoot, filePath, candidateSet, changedPaths) {
  try {
    const absolutePath = path.join(repoRoot, filePath);
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile() || stat.size > 700 * 1024) {
      return [];
    }

    const content = await fs.readFile(absolutePath, "utf8");
    const specifiers = extractImportSpecifiers(content);
    const imports = new Set();

    for (const specifier of specifiers) {
      const resolved = resolveImportSpecifier(filePath, specifier, candidateSet);
      if (resolved) {
        imports.add(resolved);
        continue;
      }

      const inferred = inferAliasImport(specifier, changedPaths);
      if (inferred) {
        imports.add(inferred);
      }
    }

    return [...imports];
  } catch {
    return [];
  }
}

function extractImportSpecifiers(content) {
  const specifiers = new Set();
  const patterns = [
    /\bimport\s+(?:type\s+)?(?:[^'"]+\s+from\s+)?["']([^"']+)["']/g,
    /\bexport\s+(?:type\s+)?[^'"]*\s+from\s+["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
    /@import\s+(?:url\()?["']([^"']+)["']\)?/g
  ];

  for (const pattern of patterns) {
    let match = pattern.exec(content);
    while (match) {
      specifiers.add(match[1]);
      match = pattern.exec(content);
    }
  }

  return [...specifiers];
}

function resolveImportSpecifier(fromFile, specifier, candidateSet) {
  if (!specifier.startsWith(".")) {
    return undefined;
  }

  const base = normalizePosix(path.posix.join(path.posix.dirname(fromFile), specifier));
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((extension) => `${base}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${base}/index${extension}`)
  ];

  return candidates.find((candidate) => candidateSet.has(candidate));
}

function inferAliasImport(specifier, changedPaths) {
  if (specifier.startsWith(".") || /^[a-z]+:\/\//i.test(specifier)) {
    return undefined;
  }

  const normalizedSpecifier = stripExtension(toPosixPath(specifier.replace(/^[@~]\//, "")));
  const specifierTail = normalizedSpecifier.split("/").slice(-2).join("/");

  return changedPaths.find((changedPath) => {
    const withoutExtension = stripExtension(changedPath);
    const changedTail = withoutExtension.split("/").slice(-2).join("/");
    return withoutExtension.endsWith(normalizedSpecifier) || changedTail === specifierTail;
  });
}

function summarizeHunk(file, hunk) {
  const added = hunk.lines.filter((line) => line.type === "add");
  const deleted = hunk.lines.filter((line) => line.type === "delete");
  const changedText = [...added, ...deleted].map((line) => line.content).join("\n");
  const labels = [];
  const filePath = getDiffFilePath(file);

  if (isDependencyFile(filePath)) {
    labels.push("dependency");
  }
  if (/\b(import|export)\b.+\bfrom\b|require\(|import\(/.test(changedText)) {
    labels.push("imports");
  }
  if (/\bexport\s+(?:default\s+)?(const|function|class|interface|type|enum)\b/.test(changedText)) {
    labels.push("exports");
  }
  if (/\b(if|else|switch|case|return|throw|try|catch|await|async)\b/.test(changedText)) {
    labels.push("logic");
  }
  if (/\b(type|interface|enum)\b/.test(changedText)) {
    labels.push("types");
  }
  if (/\b(fetch|axios|graphql|query|mutation|endpoint|route|api)\b/i.test(changedText)) {
    labels.push("data");
  }
  if (/\b(test|describe|it|expect|mock|stub)\b/i.test(filePath + "\n" + changedText)) {
    labels.push("tests");
  }
  if (isStyleFile(filePath) || /(--[\w-]+|#[0-9a-f]{3,8}\b|rgba?\(|display:|grid|flex)/i.test(changedText)) {
    labels.push("styles");
  }
  if (/<[A-Z][\w.]*|className=|use[A-Z]\w+/.test(changedText)) {
    labels.push("ui");
  }

  const uniqueLabels = [...new Set(labels)];
  return {
    title: getHunkTitle(uniqueLabels, hunk),
    labels: uniqueLabels.slice(0, 4),
    added: added.length,
    deleted: deleted.length,
    balance: added.length > deleted.length ? "expanded" : added.length < deleted.length ? "reduced" : "changed"
  };
}

function getHunkTitle(labels, hunk) {
  if (labels.includes("dependency")) {
    return "Dependency surface changed";
  }
  if (labels.includes("imports")) {
    return "Connections changed";
  }
  if (labels.includes("exports")) {
    return "Public surface changed";
  }
  if (labels.includes("data")) {
    return "Data path changed";
  }
  if (labels.includes("logic")) {
    return "Behavior changed";
  }
  if (labels.includes("ui")) {
    return "UI structure changed";
  }
  if (labels.includes("styles")) {
    return "Visual styling changed";
  }
  if (labels.includes("tests")) {
    return "Test coverage changed";
  }
  if (labels.includes("types")) {
    return "Type contract changed";
  }
  return hunk.section ? "Local change" : "Code changed";
}

function getFileTags(file, filePath) {
  const tags = [getFileKind(filePath)];
  if (isDependencyFile(filePath)) {
    tags.push("dependency");
  }
  if (file.hunks.some((hunk) => hunk.insight && hunk.insight.labels.includes("imports"))) {
    tags.push("imports");
  }
  if (file.additions + file.deletions > 120) {
    tags.push("large");
  }
  return [...new Set(tags)].filter(Boolean);
}

function getFileWeight(file) {
  const lineWeight = Math.min(file.additions + file.deletions, 200);
  const hunkWeight = file.hunks.length * 6;
  const statusWeight = file.status === "added" || file.status === "deleted" ? 12 : 0;
  return lineWeight + hunkWeight + statusWeight;
}

function getFileKind(filePath) {
  if (!filePath) {
    return "file";
  }
  if (/\.(test|spec)\.[cm]?[jt]sx?$/i.test(filePath) || /(^|\/)(__tests__|test|tests)\//i.test(filePath)) {
    return "test";
  }
  if (isDependencyFile(filePath)) {
    return "dependency";
  }
  if (/\.(css|scss|sass|less|pcss)$/i.test(filePath)) {
    return "style";
  }
  if (/\.(tsx|jsx|vue|svelte)$/i.test(filePath)) {
    return "ui";
  }
  if (/\.(ts|js|mts|mjs|cts|cjs)$/i.test(filePath)) {
    return "code";
  }
  if (/\.(json|ya?ml|toml|ini)$/i.test(filePath)) {
    return "config";
  }
  if (/\.(md|mdx|txt)$/i.test(filePath)) {
    return "docs";
  }
  return "file";
}

function getImpactRisk(filePath, workspaceImporterCount, importsChangedCount, changedImporterCount) {
  if (isDependencyFile(filePath) || workspaceImporterCount >= 8 || changedImporterCount >= 3) {
    return "high";
  }
  if (workspaceImporterCount > 0 || importsChangedCount > 0 || /types?|schema|contract|api/i.test(filePath)) {
    return "medium";
  }
  return "low";
}

function isLikelySourceFile(filePath) {
  return SOURCE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}

function isDependencyFile(filePath) {
  return /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|requirements\.txt|Cargo\.toml|go\.mod)$/i.test(filePath);
}

function isStyleFile(filePath) {
  return /\.(css|scss|sass|less|pcss)$/i.test(filePath);
}

function getDiffFilePath(file) {
  return file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
}

function toPosixPath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function normalizePosix(filePath) {
  return toPosixPath(path.posix.normalize(filePath));
}

function stripExtension(filePath) {
  return toPosixPath(filePath).replace(/\.[^.\/]+$/, "");
}

function createFile(diffGitLine) {
  const parsed = parseDiffGitLine(diffGitLine);
  return {
    id: stableId(`${parsed.oldPath}:${parsed.newPath}`),
    oldPath: parsed.oldPath,
    newPath: parsed.newPath,
    status: "modified",
    additions: 0,
    deletions: 0,
    hunks: []
  };
}

function parseDiffGitLine(line) {
  const rest = line.slice("diff --git ".length);
  const parts = parseGitPathTokens(rest);
  return {
    oldPath: stripDiffPrefix(parts[0] || ""),
    newPath: stripDiffPrefix(parts[1] || parts[0] || "")
  };
}

function normalizeDiffPath(rawPath) {
  const trimmed = rawPath.trim();
  if (trimmed === "/dev/null") {
    return "/dev/null";
  }

  return stripDiffPrefix(trimmed);
}

function stripDiffPrefix(value) {
  return unquoteGitPath(value).replace(/^[ab]\//, "");
}

function parseGitPathTokens(value) {
  const tokens = [];
  let index = 0;

  while (index < value.length) {
    while (value[index] === " ") {
      index += 1;
    }

    if (index >= value.length) {
      break;
    }

    if (value[index] === "\"") {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < value.length) {
        const char = value[index];
        if (char === "\"" && !escaped) {
          index += 1;
          break;
        }
        escaped = char === "\\" && !escaped;
        if (char !== "\\") {
          escaped = false;
        }
        index += 1;
      }
      tokens.push(value.slice(start, index));
      continue;
    }

    const start = index;
    while (index < value.length && value[index] !== " ") {
      index += 1;
    }
    tokens.push(value.slice(start, index));
  }

  return tokens;
}

function unquoteGitPath(value) {
  if (!value) {
    return value;
  }

  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }

  return value;
}

function addHunkLine(hunk, rawLine) {
  if (rawLine.startsWith("+")) {
    hunk.lines.push({
      type: "add",
      content: rawLine.slice(1),
      oldLine: null,
      newLine: hunk.newCursor
    });
    hunk.newCursor += 1;
    return;
  }

  if (rawLine.startsWith("-")) {
    hunk.lines.push({
      type: "delete",
      content: rawLine.slice(1),
      oldLine: hunk.oldCursor,
      newLine: null
    });
    hunk.oldCursor += 1;
    return;
  }

  if (rawLine.startsWith("\\")) {
    hunk.lines.push({
      type: "meta",
      content: rawLine,
      oldLine: null,
      newLine: null
    });
    return;
  }

  const content = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
  hunk.lines.push({
    type: "context",
    content,
    oldLine: hunk.oldCursor,
    newLine: hunk.newCursor
  });
  hunk.oldCursor += 1;
  hunk.newCursor += 1;
}

function getWebviewHtml(webview, state) {
  const nonce = getNonce();
  const payload = JSON.stringify(state).replace(/</g, "\\u003c");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(state.title)}</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --surface: var(--vscode-editor-background);
      --surface-raised: var(--vscode-sideBar-background);
      --surface-subtle: var(--vscode-editorWidget-background);
      --text: var(--vscode-editor-foreground);
      --text-muted: var(--vscode-descriptionForeground);
      --border: var(--vscode-panel-border);
      --focus: var(--vscode-focusBorder);
      --added-bg: rgba(35, 134, 54, 0.16);
      --added-strong: rgba(35, 134, 54, 0.32);
      --deleted-bg: rgba(248, 81, 73, 0.16);
      --deleted-strong: rgba(248, 81, 73, 0.32);
      --changed-bg: rgba(187, 128, 9, 0.16);
      --accent: var(--vscode-textLink-foreground);
      --accent-soft: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent);
      --risk-low: rgba(35, 134, 54, 0.24);
      --risk-medium: rgba(187, 128, 9, 0.26);
      --risk-high: rgba(248, 81, 73, 0.26);
      --motion-dur: 180ms;
      --motion-ease: cubic-bezier(0.22, 1, 0.36, 1);
      --code-font: var(--vscode-editor-font-family);
      --ui-font: var(--vscode-font-family);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-width: 320px;
      color: var(--text);
      background: var(--surface);
      font-family: var(--ui-font);
      font-size: var(--vscode-font-size);
    }

    button,
    input {
      font: inherit;
    }

    button {
      min-height: 30px;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 5px 9px;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
      transition:
        background-color var(--motion-dur) var(--motion-ease),
        border-color var(--motion-dur) var(--motion-ease),
        transform var(--motion-dur) var(--motion-ease);
    }

    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }

    button:active {
      transform: translateY(1px);
    }

    button:disabled {
      cursor: not-allowed;
      opacity: 0.55;
      transform: none;
    }

    button:focus-visible,
    input:focus-visible,
    a:focus-visible {
      outline: 1px solid var(--focus);
      outline-offset: 2px;
    }

    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
    }

    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }

    .title-group {
      min-width: 0;
    }

    h1,
    h2,
    h3,
    p {
      margin: 0;
    }

    h1 {
      font-size: 17px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .metadata {
      margin-top: 4px;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .summary {
      display: grid;
      grid-template-columns: repeat(6, minmax(100px, 1fr));
      gap: 1px;
      border-bottom: 1px solid var(--border);
      background: var(--border);
    }

    .metric {
      min-height: 62px;
      padding: 10px 14px;
      background: var(--surface-raised);
    }

    .metric-label {
      color: var(--text-muted);
      font-size: 11px;
      text-transform: uppercase;
    }

    .metric-value {
      margin-top: 6px;
      font-size: 18px;
      font-weight: 650;
    }

    .layout {
      min-height: 0;
      display: grid;
      grid-template-columns: minmax(230px, 300px) minmax(0, 1fr) minmax(260px, 340px);
    }

    .sidebar {
      min-height: 0;
      border-right: 1px solid var(--border);
      background: var(--surface-raised);
      display: grid;
      grid-template-rows: auto auto minmax(0, 1fr);
    }

    .filter-block {
      padding: 12px;
      border-bottom: 1px solid var(--border);
    }

    .filter-input {
      width: 100%;
      min-height: 32px;
      border: 1px solid var(--vscode-input-border, var(--border));
      border-radius: 6px;
      padding: 6px 9px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
    }

    .status-filters {
      display: flex;
      gap: 6px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
    }

    .status-filter {
      flex: 0 0 auto;
    }

    .status-filter[aria-pressed="true"] {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: var(--vscode-button-background);
    }

    .file-list {
      min-height: 0;
      overflow: auto;
      padding: 8px;
    }

    .file-link {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 38px;
      margin: 0 0 4px;
      border-color: transparent;
      text-align: left;
      background: transparent;
      color: var(--text);
      transition:
        background-color var(--motion-dur) var(--motion-ease),
        border-color var(--motion-dur) var(--motion-ease),
        transform var(--motion-dur) var(--motion-ease);
    }

    .file-link:hover,
    .file-link.is-active {
      background: var(--vscode-list-hoverBackground);
    }

    .file-link.is-active {
      border-color: var(--focus);
      transform: translateX(2px);
    }

    .file-link-main {
      min-width: 0;
      display: grid;
      gap: 3px;
    }

    .file-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-meta {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--text-muted);
      font-size: 11px;
      overflow: hidden;
    }

    .file-stats {
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }

    .reader {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      scroll-behavior: smooth;
      background: var(--surface);
    }

    .reader-inner {
      max-width: 1180px;
      margin: 0 auto;
      padding: 1px 0 24px;
    }

    .empty-state {
      max-width: 520px;
      margin: 80px auto;
      padding: 0 24px;
      text-align: center;
      color: var(--text-muted);
    }

    .file-diff {
      margin: 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      overflow: hidden;
      background: var(--surface);
      animation: surface-enter 220ms var(--motion-ease) both;
      transition:
        border-color var(--motion-dur) var(--motion-ease),
        transform var(--motion-dur) var(--motion-ease),
        box-shadow var(--motion-dur) var(--motion-ease);
    }

    .file-diff:hover {
      border-color: color-mix(in srgb, var(--focus) 54%, var(--border));
      box-shadow: 0 8px 26px rgba(0, 0, 0, 0.12);
      transform: translateY(-1px);
    }

    .file-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border);
      background: var(--surface-subtle);
    }

    .file-heading {
      min-width: 0;
    }

    .file-heading-top {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex-wrap: wrap;
    }

    .file-heading h2 {
      margin-top: 5px;
      font-size: 14px;
      font-weight: 650;
      letter-spacing: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .tag-row {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      margin-top: 8px;
    }

    .tag {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 20px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 7px;
      color: var(--text-muted);
      background: var(--surface);
      font-size: 11px;
      line-height: 1;
      white-space: nowrap;
    }

    .tag.impact-high {
      color: var(--text);
      background: var(--risk-high);
    }

    .tag.impact-medium {
      color: var(--text);
      background: var(--risk-medium);
    }

    .tag.impact-low {
      color: var(--text);
      background: var(--risk-low);
    }

    .risk-dot {
      width: 7px;
      height: 7px;
      border-radius: 999px;
      background: currentColor;
    }

    .file-subtitle {
      margin-top: 4px;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .file-actions {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .status-badge {
      display: inline-flex;
      align-items: center;
      min-height: 20px;
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 11px;
      text-transform: uppercase;
      color: var(--text-muted);
      background: var(--surface);
    }

    .status-badge.added {
      color: var(--vscode-gitDecoration-addedResourceForeground, var(--text));
      background: var(--added-bg);
    }

    .status-badge.deleted {
      color: var(--vscode-gitDecoration-deletedResourceForeground, var(--text));
      background: var(--deleted-bg);
    }

    .status-badge.renamed {
      color: var(--vscode-gitDecoration-renamedResourceForeground, var(--text));
      background: var(--changed-bg);
    }

    .hunk {
      border-bottom: 1px solid var(--border);
    }

    .hunk:last-child {
      border-bottom: 0;
    }

    .hunk-header {
      position: sticky;
      top: 0;
      z-index: 1;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 12px;
      min-height: 32px;
      padding: 8px 10px;
      color: var(--text-muted);
      background: var(--surface-subtle);
      border-bottom: 1px solid var(--border);
    }

    .hunk-title {
      min-width: 0;
      display: grid;
      gap: 2px;
    }

    .hunk-title strong {
      color: var(--text);
      font-size: 12px;
      font-weight: 650;
    }

    .hunk-title span {
      overflow: hidden;
      color: var(--text-muted);
      font-family: var(--code-font);
      font-size: 11px;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .hunk-chips {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .hunk-lines {
      overflow-x: auto;
    }

    .diff-line {
      display: grid;
      grid-template-columns: 58px 58px minmax(0, 1fr);
      min-width: max-content;
      min-height: 22px;
      font-family: var(--code-font);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.55;
      transition: background-color var(--motion-dur) var(--motion-ease);
    }

    .diff-line.add {
      background: var(--added-bg);
    }

    .diff-line.delete {
      background: var(--deleted-bg);
    }

    .diff-line.meta {
      color: var(--text-muted);
      background: var(--surface-subtle);
    }

    .line-number {
      padding: 0 8px;
      border-right: 1px solid var(--border);
      color: var(--text-muted);
      text-align: right;
      user-select: none;
      font-variant-numeric: tabular-nums;
    }

    .line-code {
      min-width: 0;
      padding: 0 12px;
      white-space: pre;
    }

    .inline-add {
      border-radius: 3px;
      background: var(--added-strong);
    }

    .inline-delete {
      border-radius: 3px;
      background: var(--deleted-strong);
    }

    .impact-rail {
      min-width: 0;
      min-height: 0;
      overflow: auto;
      border-left: 1px solid var(--border);
      background: var(--surface-raised);
    }

    .impact-inner {
      display: grid;
      gap: 12px;
      padding: 12px;
    }

    .insight-card {
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      background: var(--surface);
      animation: surface-enter 220ms var(--motion-ease) both;
    }

    .insight-card h2,
    .insight-card h3 {
      margin: 0;
      color: var(--text);
      font-size: 13px;
      font-weight: 650;
      letter-spacing: 0;
    }

    .insight-card p {
      margin-top: 6px;
      color: var(--text-muted);
      line-height: 1.45;
    }

    .impact-list {
      display: grid;
      gap: 8px;
      margin-top: 10px;
    }

    .impact-item {
      width: 100%;
      display: grid;
      gap: 6px;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 8px;
      color: var(--text);
      background: var(--surface-subtle);
      text-align: left;
      transition:
        background-color var(--motion-dur) var(--motion-ease),
        border-color var(--motion-dur) var(--motion-ease),
        transform var(--motion-dur) var(--motion-ease);
    }

    .impact-item:hover {
      border-color: var(--focus);
      transform: translateY(-1px);
    }

    .impact-item-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }

    .impact-item-meta {
      color: var(--text-muted);
      font-size: 11px;
      line-height: 1.4;
    }

    .relationship-list {
      display: grid;
      gap: 6px;
      margin-top: 8px;
    }

    .relationship {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: 3px;
      border-left: 2px solid var(--accent);
      padding: 4px 0 4px 8px;
      color: var(--text-muted);
      font-size: 11px;
    }

    .relationship strong {
      min-width: 0;
      overflow: hidden;
      color: var(--text);
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    @keyframes surface-enter {
      from {
        opacity: 0;
        transform: translateY(6px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    .sr-only {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }

    @media (max-width: 820px) {
      .topbar {
        align-items: flex-start;
        flex-direction: column;
      }

      .summary {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .layout {
        grid-template-columns: 1fr;
      }

      .sidebar {
        max-height: 260px;
        border-right: 0;
        border-bottom: 1px solid var(--border);
      }

      .impact-rail {
        max-height: 360px;
        border-left: 0;
        border-top: 1px solid var(--border);
      }

      .file-header {
        align-items: flex-start;
        flex-direction: column;
      }
    }

    @media (prefers-reduced-motion: reduce) {
      *,
      *::before,
      *::after {
        animation-duration: 1ms !important;
        transition-duration: 1ms !important;
        scroll-behavior: auto !important;
      }
    }
  </style>
</head>
<body>
  <main class="app">
    <header class="topbar">
      <div class="title-group">
        <h1>Diff-erent</h1>
        <p class="metadata" id="metadata"></p>
      </div>
      <div class="actions" aria-label="Diff actions">
        <button type="button" id="refreshButton" title="Refresh">Refresh</button>
        <button type="button" id="expandButton" title="Toggle context">Expand context</button>
      </div>
    </header>
    <section class="summary" id="summary" aria-label="Diff summary"></section>
    <div class="layout">
      <aside class="sidebar" aria-label="Changed files">
        <div class="filter-block">
          <label class="sr-only" for="fileFilter">Filter files</label>
          <input class="filter-input" id="fileFilter" type="search" placeholder="Filter files">
        </div>
        <div class="status-filters" aria-label="Status filters" id="statusFilters"></div>
        <nav class="file-list" id="fileList" aria-label="Files"></nav>
      </aside>
      <section class="reader" id="reader" tabindex="-1" aria-label="Diff reader"></section>
      <aside class="impact-rail" id="impactRail" aria-label="Impact analysis"></aside>
    </div>
  </main>
  <script nonce="${nonce}" id="different-data" type="application/json">${payload}</script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const state = JSON.parse(document.getElementById("different-data").textContent);
    const view = {
      filter: "",
      status: "all",
      expanded: false,
      activeFileId: ""
    };

    const elements = {
      metadata: document.getElementById("metadata"),
      summary: document.getElementById("summary"),
      fileFilter: document.getElementById("fileFilter"),
      statusFilters: document.getElementById("statusFilters"),
      fileList: document.getElementById("fileList"),
      reader: document.getElementById("reader"),
      impactRail: document.getElementById("impactRail"),
      refreshButton: document.getElementById("refreshButton"),
      expandButton: document.getElementById("expandButton")
    };

    elements.metadata.textContent = [state.prototypeVersion, state.gitSummary.repoName, state.gitSummary.branch, state.rangeLabel]
      .filter(Boolean)
      .join(" / ");

    elements.refreshButton.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
    elements.expandButton.addEventListener("click", () => {
      view.expanded = !view.expanded;
      elements.expandButton.textContent = view.expanded ? "Compact context" : "Expand context";
      render();
    });
    elements.fileFilter.addEventListener("input", (event) => {
      view.filter = event.target.value.toLowerCase();
      render();
    });

    render();

    function render() {
      renderSummary();
      renderStatusFilters();
      renderFileList();
      renderReader();
      renderImpactRail();
    }

    function renderSummary() {
      const metrics = [
        ["Files", state.totals.files],
        ["Hunks", state.totals.hunks],
        ["Added", "+" + state.totals.additions],
        ["Deleted", "-" + state.totals.deletions],
        ["Impact", getImpactSummaryLabel()],
        ["Range", state.rangeLabel]
      ];
      elements.summary.replaceChildren(...metrics.map(([label, value]) => {
        const item = document.createElement("div");
        item.className = "metric";
        const labelNode = document.createElement("div");
        labelNode.className = "metric-label";
        labelNode.textContent = label;
        const valueNode = document.createElement("div");
        valueNode.className = "metric-value";
        valueNode.textContent = value;
        item.append(labelNode, valueNode);
        return item;
      }));
    }

    function renderStatusFilters() {
      const statuses = [
        ["all", "All"],
        ["modified", "Modified"],
        ["added", "Added"],
        ["deleted", "Deleted"],
        ["renamed", "Renamed"]
      ];

      elements.statusFilters.replaceChildren(...statuses.map(([status, label]) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "status-filter";
        button.textContent = label;
        button.setAttribute("aria-pressed", String(view.status === status));
        button.addEventListener("click", () => {
          view.status = status;
          render();
        });
        return button;
      }));
    }

    function getVisibleFiles() {
      return state.files.filter((file) => {
        const filePath = getFilePath(file).toLowerCase();
        const statusMatches = view.status === "all" || file.status === view.status;
        const filterMatches = !view.filter || filePath.includes(view.filter);
        return statusMatches && filterMatches;
      });
    }

    function renderFileList() {
      const visibleFiles = getVisibleFiles();
      if (!view.activeFileId || !visibleFiles.some((file) => file.id === view.activeFileId)) {
        view.activeFileId = visibleFiles[0] ? visibleFiles[0].id : "";
      }

      if (visibleFiles.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty-state";
        empty.textContent = "No matching files.";
        elements.fileList.replaceChildren(empty);
        return;
      }

      elements.fileList.replaceChildren(...visibleFiles.map((file) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "file-link" + (file.id === view.activeFileId ? " is-active" : "");
        button.addEventListener("click", () => {
          view.activeFileId = file.id;
          const target = document.getElementById("file-" + file.id);
          if (target) {
            target.scrollIntoView({ block: "start" });
          }
          renderFileList();
          renderImpactRail();
        });

        const main = document.createElement("span");
        main.className = "file-link-main";

        const name = document.createElement("span");
        name.className = "file-name";
        name.textContent = getFilePath(file);

        const meta = document.createElement("span");
        meta.className = "file-meta";
        meta.textContent = [file.kind, getFileImpactLabel(file)].filter(Boolean).join(" / ");

        const stats = document.createElement("span");
        stats.className = "file-stats";
        stats.textContent = "+" + file.additions + " -" + file.deletions;
        main.append(name, meta);
        button.append(main, stats);
        return button;
      }));
    }

    function renderReader() {
      const visibleFiles = getVisibleFiles();
      if (state.files.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "No changes.";
        elements.reader.replaceChildren(empty);
        return;
      }

      if (visibleFiles.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-state";
        empty.textContent = "No matching changes.";
        elements.reader.replaceChildren(empty);
        return;
      }

      const inner = document.createElement("div");
      inner.className = "reader-inner";
      inner.append(...visibleFiles.map(renderFile));
      elements.reader.replaceChildren(inner);
    }

    function renderFile(file) {
      const article = document.createElement("article");
      article.className = "file-diff";
      article.id = "file-" + file.id;

      const header = document.createElement("header");
      header.className = "file-header";

      const heading = document.createElement("div");
      heading.className = "file-heading";

      const badge = document.createElement("span");
      badge.className = "status-badge " + file.status;
      badge.textContent = file.status;

      const title = document.createElement("h2");
      title.textContent = getFilePath(file);

      const subtitle = document.createElement("p");
      subtitle.className = "file-subtitle";
      subtitle.textContent = getSubtitle(file);

      const headingTop = document.createElement("div");
      headingTop.className = "file-heading-top";
      headingTop.append(badge, ...renderFileTags(file));

      heading.append(headingTop, title, subtitle);

      const actions = document.createElement("div");
      actions.className = "file-actions";

      const openButton = document.createElement("button");
      openButton.type = "button";
      openButton.textContent = "Open file";
      openButton.disabled = file.newPath === "/dev/null";
      openButton.addEventListener("click", () => vscode.postMessage({
        type: "openFile",
        newPath: file.newPath,
        filePath: getFilePath(file)
      }));

      const nativeButton = document.createElement("button");
      nativeButton.type = "button";
      nativeButton.textContent = "Native diff";
      nativeButton.addEventListener("click", () => vscode.postMessage({
        type: "openNativeDiff",
        oldPath: file.oldPath,
        newPath: file.newPath
      }));

      actions.append(openButton, nativeButton);
      header.append(heading, actions);

      const hunks = document.createElement("div");
      hunks.className = "hunks";
      hunks.append(...file.hunks.map(renderHunk));
      article.append(header, hunks);
      return article;
    }

    function renderHunk(hunk) {
      const section = document.createElement("section");
      section.className = "hunk";

      const header = document.createElement("div");
      header.className = "hunk-header";

      const title = document.createElement("div");
      title.className = "hunk-title";
      const titleText = document.createElement("strong");
      titleText.textContent = hunk.insight ? hunk.insight.title : "Code changed";
      const sectionLabel = document.createElement("span");
      sectionLabel.textContent = hunk.section ? hunk.section : hunk.header;
      title.append(titleText, sectionLabel);

      const chips = document.createElement("div");
      chips.className = "hunk-chips";
      if (hunk.insight) {
        chips.append(
          renderTag("+" + hunk.insight.added),
          renderTag("-" + hunk.insight.deleted),
          ...hunk.insight.labels.map(renderTag)
        );
      }
      header.append(title, chips);

      const lines = document.createElement("div");
      lines.className = "hunk-lines";
      const inlineMap = buildInlineMap(hunk.lines);
      const displayLines = view.expanded ? hunk.lines : compactLines(hunk.lines);
      lines.append(...displayLines.map((line, index) => {
        if (line.type === "fold") {
          return renderFoldLine(line);
        }
        return renderDiffLine(line, inlineMap.get(line));
      }));

      section.append(header, lines);
      return section;
    }

    function renderImpactRail() {
      const activeFile = state.files.find((file) => file.id === view.activeFileId) || state.files[0];
      const activePath = activeFile ? getFilePath(activeFile) : "";
      const activeImpact = activePath ? getImpactItem(activePath) : undefined;

      const inner = document.createElement("div");
      inner.className = "impact-inner";

      const overview = document.createElement("section");
      overview.className = "insight-card";
      const overviewTitle = document.createElement("h2");
      overviewTitle.textContent = "Impact";
      const overviewCopy = document.createElement("p");
      overviewCopy.textContent = getImpactOverviewCopy();
      overview.append(overviewTitle, overviewCopy);

      if (state.impact && state.impact.note) {
        const note = document.createElement("p");
        note.textContent = state.impact.note;
        overview.append(note);
      }

      const active = document.createElement("section");
      active.className = "insight-card";
      const activeTitle = document.createElement("h3");
      activeTitle.textContent = activePath ? "Selected file" : "Selected file";
      const activeCopy = document.createElement("p");
      activeCopy.textContent = activePath
        ? getSelectedImpactCopy(activePath, activeImpact)
        : "Select a changed file to inspect its relationships.";
      active.append(activeTitle, activeCopy);

      if (activeImpact) {
        active.append(renderRelationshipGroup("Imports changed files", activeImpact.importsChanged, "This file depends on these changed files."));
        active.append(renderRelationshipGroup("Imported by changed files", activeImpact.importedByChanged, "These changed files depend on this file."));
        active.append(renderRelationshipGroup("Imported elsewhere", activeImpact.importedByWorkspace, "Unchanged files that import this file."));
      }

      const riskCard = document.createElement("section");
      riskCard.className = "insight-card";
      const riskTitle = document.createElement("h3");
      riskTitle.textContent = "Files to review first";
      const riskList = document.createElement("div");
      riskList.className = "impact-list";
      const items = getPriorityImpactItems().slice(0, 6);
      if (items.length === 0) {
        const empty = document.createElement("p");
        empty.textContent = "No import relationships found for this change.";
        riskList.append(empty);
      } else {
        riskList.append(...items.map(renderImpactItem));
      }
      riskCard.append(riskTitle, riskList);

      inner.append(overview, active, riskCard);
      elements.impactRail.replaceChildren(inner);
    }

    function renderRelationshipGroup(title, paths, emptyText) {
      const section = document.createElement("div");
      section.className = "relationship-list";
      const heading = document.createElement("p");
      heading.textContent = title;
      section.append(heading);

      if (!paths || paths.length === 0) {
        const empty = document.createElement("div");
        empty.className = "relationship";
        empty.textContent = emptyText;
        section.append(empty);
        return section;
      }

      section.append(...paths.map((filePath) => {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "impact-item";
        item.addEventListener("click", () => vscode.postMessage({ type: "openFile", filePath }));
        const name = document.createElement("span");
        name.className = "impact-item-title";
        name.textContent = filePath;
        const meta = document.createElement("span");
        meta.className = "impact-item-meta";
        meta.textContent = getFileKindLabel(filePath);
        item.append(name, meta);
        return item;
      }));

      return section;
    }

    function renderImpactItem(item) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "impact-item";
      button.addEventListener("click", () => {
        const file = state.files.find((nextFile) => getFilePath(nextFile) === item.path);
        if (file) {
          view.activeFileId = file.id;
          const target = document.getElementById("file-" + file.id);
          if (target) {
            target.scrollIntoView({ block: "start" });
          }
          render();
        } else {
          vscode.postMessage({ type: "openFile", filePath: item.path });
        }
      });

      const name = document.createElement("span");
      name.className = "impact-item-title";
      name.textContent = item.path;
      const meta = document.createElement("span");
      meta.className = "impact-item-meta";
      meta.textContent = getImpactItemMeta(item);
      button.append(name, renderTag(item.risk + " risk", "impact-" + item.risk), meta);
      return button;
    }

    function renderFoldLine(line) {
      const row = document.createElement("div");
      row.className = "diff-line meta";
      const oldNumber = document.createElement("span");
      oldNumber.className = "line-number";
      const newNumber = document.createElement("span");
      newNumber.className = "line-number";
      const code = document.createElement("span");
      code.className = "line-code";
      code.textContent = line.count + " unchanged lines";
      row.append(oldNumber, newNumber, code);
      return row;
    }

    function renderDiffLine(line, inlineHtml) {
      const row = document.createElement("div");
      row.className = "diff-line " + line.type;

      const oldNumber = document.createElement("span");
      oldNumber.className = "line-number";
      oldNumber.textContent = line.oldLine == null ? "" : String(line.oldLine);

      const newNumber = document.createElement("span");
      newNumber.className = "line-number";
      newNumber.textContent = line.newLine == null ? "" : String(line.newLine);

      const code = document.createElement("span");
      code.className = "line-code";
      if (inlineHtml) {
        code.innerHTML = inlineHtml;
      } else {
        code.textContent = getLinePrefix(line.type) + line.content;
      }

      row.append(oldNumber, newNumber, code);
      return row;
    }

    function compactLines(lines) {
      const result = [];
      let contextRun = [];

      for (const line of lines) {
        if (line.type === "context") {
          contextRun.push(line);
          continue;
        }

        flushContextRun(result, contextRun);
        contextRun = [];
        result.push(line);
      }

      flushContextRun(result, contextRun);
      return result;
    }

    function flushContextRun(result, contextRun) {
      if (contextRun.length <= 6) {
        result.push(...contextRun);
        return;
      }

      result.push(...contextRun.slice(0, 3));
      result.push({ type: "fold", count: contextRun.length - 6 });
      result.push(...contextRun.slice(-3));
    }

    function buildInlineMap(lines) {
      const map = new Map();
      let index = 0;
      while (index < lines.length) {
        if (lines[index].type !== "delete") {
          index += 1;
          continue;
        }

        const deleted = [];
        while (lines[index] && lines[index].type === "delete") {
          deleted.push(lines[index]);
          index += 1;
        }

        const added = [];
        while (lines[index] && lines[index].type === "add") {
          added.push(lines[index]);
          index += 1;
        }

        const pairs = Math.min(deleted.length, added.length);
        for (let pairIndex = 0; pairIndex < pairs; pairIndex += 1) {
          const diff = diffTokens(deleted[pairIndex].content, added[pairIndex].content);
          map.set(deleted[pairIndex], "-" + diff.oldHtml);
          map.set(added[pairIndex], "+" + diff.newHtml);
        }
      }
      return map;
    }

    function diffTokens(oldText, newText) {
      const oldTokens = tokenize(oldText);
      const newTokens = tokenize(newText);
      if (oldTokens.length * newTokens.length > 12000) {
        return {
          oldHtml: escapeHtml(oldText),
          newHtml: escapeHtml(newText)
        };
      }

      const table = Array.from({ length: oldTokens.length + 1 }, () => Array(newTokens.length + 1).fill(0));
      for (let oldIndex = oldTokens.length - 1; oldIndex >= 0; oldIndex -= 1) {
        for (let newIndex = newTokens.length - 1; newIndex >= 0; newIndex -= 1) {
          if (oldTokens[oldIndex] === newTokens[newIndex]) {
            table[oldIndex][newIndex] = table[oldIndex + 1][newIndex + 1] + 1;
          } else {
            table[oldIndex][newIndex] = Math.max(table[oldIndex + 1][newIndex], table[oldIndex][newIndex + 1]);
          }
        }
      }

      let oldIndex = 0;
      let newIndex = 0;
      const oldParts = [];
      const newParts = [];

      while (oldIndex < oldTokens.length || newIndex < newTokens.length) {
        if (oldIndex < oldTokens.length && newIndex < newTokens.length && oldTokens[oldIndex] === newTokens[newIndex]) {
          const escaped = escapeHtml(oldTokens[oldIndex]);
          oldParts.push(escaped);
          newParts.push(escaped);
          oldIndex += 1;
          newIndex += 1;
        } else if (newIndex < newTokens.length && (oldIndex === oldTokens.length || table[oldIndex][newIndex + 1] >= table[oldIndex + 1][newIndex])) {
          newParts.push('<span class="inline-add">' + escapeHtml(newTokens[newIndex]) + "</span>");
          newIndex += 1;
        } else if (oldIndex < oldTokens.length) {
          oldParts.push('<span class="inline-delete">' + escapeHtml(oldTokens[oldIndex]) + "</span>");
          oldIndex += 1;
        }
      }

      return {
        oldHtml: oldParts.join(""),
        newHtml: newParts.join("")
      };
    }

    function tokenize(text) {
      return text.match(/\\s+|[^\\s]+/g) || [];
    }

    function getLinePrefix(type) {
      if (type === "add") {
        return "+";
      }
      if (type === "delete") {
        return "-";
      }
      return " ";
    }

    function renderFileTags(file) {
      const tags = [];
      const impact = getImpactItem(getFilePath(file));
      if (impact) {
        tags.push(renderTag(impact.risk + " impact", "impact-" + impact.risk));
      }

      for (const tag of file.tags || []) {
        tags.push(renderTag(tag));
      }

      return tags.slice(0, 5);
    }

    function renderTag(label, extraClass) {
      const tag = document.createElement("span");
      tag.className = "tag" + (extraClass ? " " + extraClass : "");
      if (extraClass && extraClass.startsWith("impact-")) {
        const dot = document.createElement("span");
        dot.className = "risk-dot";
        tag.append(dot);
      }
      tag.append(document.createTextNode(label));
      return tag;
    }

    function getImpactItem(filePath) {
      return state.impact && state.impact.items
        ? state.impact.items.find((item) => item.path === filePath)
        : undefined;
    }

    function getImpactSummaryLabel() {
      if (!state.impact || !state.impact.items || state.impact.items.length === 0) {
        return "None found";
      }

      const high = state.impact.items.filter((item) => item.risk === "high").length;
      const medium = state.impact.items.filter((item) => item.risk === "medium").length;
      if (high > 0) {
        return high + " high";
      }
      if (medium > 0) {
        return medium + " medium";
      }
      return "Low";
    }

    function getFileImpactLabel(file) {
      const impact = getImpactItem(getFilePath(file));
      if (!impact) {
        return "";
      }

      const total = impact.importsChanged.length + impact.importedByChanged.length + impact.importedByWorkspaceCount;
      return total > 0 ? total + " links" : impact.risk + " impact";
    }

    function getImpactOverviewCopy() {
      if (!state.impact || !state.impact.items || state.impact.items.length === 0) {
        return "No static import relationships were found for these changed files.";
      }

      const changedLinks = state.impact.edges ? state.impact.edges.length : 0;
      const externalLinks = state.impact.items.reduce((sum, item) => sum + item.importedByWorkspaceCount, 0);
      return changedLinks + " changed-file links and " + externalLinks + " workspace references found.";
    }

    function getSelectedImpactCopy(filePath, impact) {
      if (!impact) {
        return filePath + " has no static import relationship in the current scan.";
      }

      const pieces = [];
      if (impact.importsChanged.length > 0) {
        pieces.push("depends on " + impact.importsChanged.length + " changed file(s)");
      }
      if (impact.importedByChanged.length > 0) {
        pieces.push("is used by " + impact.importedByChanged.length + " changed file(s)");
      }
      if (impact.importedByWorkspaceCount > 0) {
        pieces.push("is imported by " + impact.importedByWorkspaceCount + " unchanged workspace file(s)");
      }
      return pieces.length > 0 ? pieces.join(", ") + "." : "No direct import links found for " + filePath + ".";
    }

    function getPriorityImpactItems() {
      if (!state.impact || !state.impact.items) {
        return [];
      }

      const riskRank = { high: 3, medium: 2, low: 1 };
      return [...state.impact.items].sort((a, b) => {
        const riskDiff = (riskRank[b.risk] || 0) - (riskRank[a.risk] || 0);
        if (riskDiff !== 0) {
          return riskDiff;
        }
        const bLinks = b.importedByWorkspaceCount + b.importedByChanged.length + b.importsChanged.length;
        const aLinks = a.importedByWorkspaceCount + a.importedByChanged.length + a.importsChanged.length;
        return bLinks - aLinks;
      });
    }

    function getImpactItemMeta(item) {
      const parts = [];
      if (item.importsChanged.length > 0) {
        parts.push("imports " + item.importsChanged.length + " changed");
      }
      if (item.importedByChanged.length > 0) {
        parts.push("used by " + item.importedByChanged.length + " changed");
      }
      if (item.importedByWorkspaceCount > 0) {
        parts.push(item.importedByWorkspaceCount + " workspace refs");
      }
      return parts.length > 0 ? parts.join(" / ") : "No direct links";
    }

    function getFileKindLabel(filePath) {
      if (/\\.(test|spec)\\.[cm]?[jt]sx?$/i.test(filePath)) {
        return "test";
      }
      if (/\\.(tsx|jsx|vue|svelte)$/i.test(filePath)) {
        return "ui";
      }
      if (/\\.(css|scss|sass|less|pcss)$/i.test(filePath)) {
        return "style";
      }
      if (/\\.(json|ya?ml|toml)$/i.test(filePath)) {
        return "config";
      }
      return "source";
    }

    function getFilePath(file) {
      return file.newPath && file.newPath !== "/dev/null" ? file.newPath : file.oldPath;
    }

    function getSubtitle(file) {
      const counts = "+" + file.additions + " -" + file.deletions + " / " + file.hunks.length + " hunks";
      if (file.status === "renamed") {
        return file.oldPath + " -> " + file.newPath + " / " + counts;
      }
      return counts;
    }

    function escapeHtml(value) {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }
  </script>
</body>
</html>`;
}

function stableId(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function shortRef(ref) {
  return ref.length > 12 ? ref.slice(0, 12) : ref;
}

function getNonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

module.exports = {
  activate,
  deactivate,
  parseUnifiedDiff,
  enrichParsedDiff,
  buildImpactAnalysis,
  getWebviewHtml
};
