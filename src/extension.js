const path = require("node:path");
const vscode = require("vscode");

const { parseUnifiedDiff } = require("./diff");
const { enrichParsedDiff } = require("./enrich");
const { buildImpactAnalysis } = require("./impact");
const { buildCoChangeAnalysis } = require("./cochange");
const {
  execGit,
  getRepositoryRoot,
  getWorkspaceChanges,
  getStatusLabel,
  createDiffRequest,
  getGitSummary
} = require("./git");
const { getWebviewHtml } = require("./webview");
const { toPosixPath } = require("./util");

const ORIGINAL_SCHEME = "diff-erent-original";
const EMPTY_SCHEME = "diff-erent-empty";
const PROTOTYPE_VERSION = "v0.2-impact";

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
    const [impact, coChange] = await Promise.all([
      buildImpactAnalysis(repoRoot, parsed.files),
      buildCoChangeAnalysis(repoRoot, parsed.files)
    ]);
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
      coChange,
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
      const [impact, coChange] = await Promise.all([
        buildImpactAnalysis(state.repoRoot, parsed.files),
        buildCoChangeAnalysis(state.repoRoot, parsed.files)
      ]);
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
        coChange,
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

module.exports = {
  activate,
  deactivate
};
