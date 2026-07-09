// Presentation layer: builds the self-contained webview document (HTML + CSS +
// browser-side JS). Receives the already-analysed diff state and renders it.

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
      --surface-raised: color-mix(in srgb, var(--vscode-sideBar-background) 70%, var(--vscode-editor-background));
      --surface-subtle: color-mix(in srgb, var(--vscode-editorWidget-background) 60%, var(--vscode-editor-background));
      --text: var(--vscode-editor-foreground);
      --text-muted: var(--vscode-descriptionForeground);
      --border: color-mix(in srgb, var(--vscode-panel-border) 55%, transparent);
      --border-strong: var(--vscode-panel-border);
      --focus: var(--vscode-focusBorder);
      --added-bg: color-mix(in srgb, #2ea043 14%, transparent);
      --added-strong: color-mix(in srgb, #2ea043 30%, transparent);
      --added-fg: #3fb950;
      --deleted-bg: color-mix(in srgb, #f85149 13%, transparent);
      --deleted-strong: color-mix(in srgb, #f85149 28%, transparent);
      --deleted-fg: #f85149;
      --changed-bg: color-mix(in srgb, #d29922 15%, transparent);
      --accent: var(--vscode-textLink-foreground);
      --accent-soft: color-mix(in srgb, var(--vscode-textLink-foreground) 14%, transparent);
      --risk-low: color-mix(in srgb, #2ea043 22%, transparent);
      --risk-medium: color-mix(in srgb, #d29922 24%, transparent);
      --risk-high: color-mix(in srgb, #f85149 24%, transparent);
      --radius-sm: 8px;
      --radius-md: 12px;
      --radius-lg: 16px;
      --radius-pill: 999px;
      --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.18);
      --shadow-md: 0 6px 24px rgba(0, 0, 0, 0.16);
      --shadow-lg: 0 16px 48px rgba(0, 0, 0, 0.22);
      --space: 16px;
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
      min-height: 32px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 6px 12px;
      font-weight: 550;
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      cursor: pointer;
      transition:
        background-color var(--motion-dur) var(--motion-ease),
        border-color var(--motion-dur) var(--motion-ease),
        box-shadow var(--motion-dur) var(--motion-ease),
        transform var(--motion-dur) var(--motion-ease);
    }

    button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
      border-color: color-mix(in srgb, var(--focus) 40%, var(--border));
    }

    button:active {
      transform: translateY(1px);
    }

    button.primary {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: transparent;
      box-shadow: var(--shadow-sm);
    }

    button.primary:hover {
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      border-color: transparent;
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
      padding: 16px 22px;
      border-bottom: 1px solid var(--border);
      background:
        linear-gradient(180deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent),
        var(--surface);
      backdrop-filter: blur(6px);
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
      font-weight: 700;
      letter-spacing: -0.01em;
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
      gap: 10px;
      padding: 14px 22px;
      border-bottom: 1px solid var(--border);
      background: var(--surface);
    }

    .metric {
      min-height: 64px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--surface-raised);
      transition: border-color var(--motion-dur) var(--motion-ease);
    }

    .metric:hover {
      border-color: color-mix(in srgb, var(--focus) 30%, var(--border));
    }

    .metric-filter {
      text-align: left;
      cursor: pointer;
    }

    .metric-filter:hover {
      background: var(--surface-raised);
      border-color: color-mix(in srgb, var(--focus) 45%, var(--border));
      transform: translateY(-1px);
    }

    .metric-filter.is-active {
      border-color: var(--accent);
      background: var(--accent-soft);
    }

    .metric-label {
      color: var(--text-muted);
      font-size: 10.5px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
    }

    .metric-value {
      margin-top: 8px;
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.01em;
      font-variant-numeric: tabular-nums;
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
      gap: 4px;
      margin: 10px 12px;
      padding: 4px;
      border: 1px solid var(--border);
      border-radius: var(--radius-pill);
      background: var(--surface-subtle);
      overflow-x: auto;
    }

    .status-filter {
      flex: 1 1 auto;
      min-height: 26px;
      padding: 4px 10px;
      border: 1px solid transparent;
      border-radius: var(--radius-pill);
      background: transparent;
      color: var(--text-muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .status-filter:hover {
      background: var(--vscode-list-hoverBackground);
      border-color: transparent;
    }

    .status-filter[aria-pressed="true"] {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border-color: transparent;
      box-shadow: var(--shadow-sm);
    }

    .file-list {
      min-height: 0;
      overflow: auto;
      padding: 8px;
    }

    .file-link {
      position: relative;
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      align-items: center;
      min-height: 42px;
      margin: 0 0 3px;
      padding: 6px 10px 6px 12px;
      border-radius: var(--radius-sm);
      border-color: transparent;
      text-align: left;
      background: transparent;
      color: var(--text);
      transition:
        background-color var(--motion-dur) var(--motion-ease),
        border-color var(--motion-dur) var(--motion-ease);
    }

    .file-link:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .file-link.is-active {
      background: var(--accent-soft);
      border-color: transparent;
    }

    .file-link.is-active::before {
      content: "";
      position: absolute;
      left: 3px;
      top: 8px;
      bottom: 8px;
      width: 3px;
      border-radius: var(--radius-pill);
      background: var(--accent);
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
      margin: 18px 16px;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      overflow: hidden;
      background: var(--surface);
      box-shadow: var(--shadow-sm);
      animation: surface-enter 220ms var(--motion-ease) both;
      transition:
        border-color var(--motion-dur) var(--motion-ease),
        box-shadow var(--motion-dur) var(--motion-ease);
    }

    .file-diff:hover {
      border-color: color-mix(in srgb, var(--focus) 40%, var(--border));
      box-shadow: var(--shadow-md);
    }

    .file-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 14px 16px;
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

    .binary-note {
      margin: 0;
      padding: 16px 14px;
      color: var(--text-muted);
      font-style: italic;
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
      box-shadow: inset 2px 0 0 var(--added-fg);
    }

    .diff-line.delete {
      background: var(--deleted-bg);
      box-shadow: inset 2px 0 0 var(--deleted-fg);
    }

    .diff-line.meta {
      color: var(--text-muted);
      background: var(--surface-subtle);
    }

    .line-number {
      padding: 0 10px;
      color: color-mix(in srgb, var(--text-muted) 70%, transparent);
      text-align: right;
      user-select: none;
      font-variant-numeric: tabular-nums;
      font-size: 11px;
    }

    .line-number:nth-child(2) {
      border-right: 1px solid var(--border);
    }

    .line-code {
      min-width: 0;
      padding: 0 14px;
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

    .impact-item-why {
      display: block;
      margin-top: 2px;
      color: var(--text-muted);
      font-size: 11px;
      font-style: italic;
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
        <button type="button" class="primary" id="refreshButton" title="Refresh">Refresh</button>
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
        { label: "Files", value: state.totals.files, status: "all" },
        { label: "Hunks", value: state.totals.hunks },
        { label: "Added", value: "+" + state.totals.additions, status: "added" },
        { label: "Deleted", value: "-" + state.totals.deletions, status: "deleted" },
        { label: "Impact", value: getImpactSummaryLabel() },
        { label: "Range", value: state.rangeLabel }
      ];
      elements.summary.replaceChildren(...metrics.map((metric) => {
        const interactive = typeof metric.status === "string";
        const item = document.createElement(interactive ? "button" : "div");
        item.className = "metric";

        if (interactive) {
          item.type = "button";
          item.classList.add("metric-filter");
          const isActive = view.status === metric.status;
          item.classList.toggle("is-active", isActive);
          item.setAttribute("aria-pressed", String(isActive));
          item.title = metric.status === "all" ? "Show all files" : "Filter to " + metric.status + " files";
          item.addEventListener("click", () => {
            // Toggle a status filter off (back to all); "all" always shows everything.
            view.status = view.status === metric.status && metric.status !== "all" ? "all" : metric.status;
            render();
          });
        }

        const labelNode = document.createElement("div");
        labelNode.className = "metric-label";
        labelNode.textContent = metric.label;
        const valueNode = document.createElement("div");
        valueNode.className = "metric-value";
        valueNode.textContent = metric.value;
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
        stats.textContent = file.binary ? "binary" : "+" + file.additions + " -" + file.deletions;
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
      if (file.binary) {
        const note = document.createElement("p");
        note.className = "binary-note";
        note.textContent = "Binary file — contents not shown. Use Open file or Native diff to inspect.";
        hunks.append(note);
      } else {
        hunks.append(...file.hunks.map(renderHunk));
      }
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
          ...hunk.insight.labels.map((label) => renderTag(label))
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
        if (!file) {
          vscode.postMessage({ type: "openFile", filePath: item.path });
          return;
        }

        view.activeFileId = file.id;
        // Clear any active filter that would hide the target, then update the DOM
        // before scrolling — rendering the reader resets its scroll position.
        if (!getVisibleFiles().some((nextFile) => nextFile.id === file.id)) {
          view.status = "all";
          view.filter = "";
          elements.fileFilter.value = "";
          render();
        } else {
          renderFileList();
          renderImpactRail();
        }

        const target = document.getElementById("file-" + file.id);
        if (target) {
          target.scrollIntoView({ block: "start" });
        }
      });

      const name = document.createElement("span");
      name.className = "impact-item-title";
      name.textContent = item.path;
      const meta = document.createElement("span");
      meta.className = "impact-item-meta";
      meta.textContent = getImpactItemMeta(item);

      const reasons = item.riskReasons || [];
      const riskTag = renderTag(item.risk + " risk", "impact-" + item.risk);
      if (reasons.length > 0) {
        riskTag.title = reasons.join(" · ");
      }
      button.append(name, riskTag, meta);

      if (reasons.length > 0) {
        const why = document.createElement("span");
        why.className = "impact-item-why";
        why.textContent = "Why: " + reasons.join("; ");
        button.append(why);
      }
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
        const riskTag = renderTag(impact.risk + " impact", "impact-" + impact.risk);
        if (impact.riskReasons && impact.riskReasons.length > 0) {
          riskTag.title = impact.riskReasons.join(" · ");
        }
        tags.push(riskTag);
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
      const counts = file.binary
        ? "binary file"
        : "+" + file.additions + " -" + file.deletions + " / " + file.hunks.length + " hunks";
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
  getWebviewHtml
};
