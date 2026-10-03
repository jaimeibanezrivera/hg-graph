const vscode = require("vscode");
const { execFile } = require("child_process");
const path = require("path");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const FIELD = "\x1f";
const RECORD = "\x1e";

async function runHg(cwd, args) {
  const { stdout } = await execFileAsync("hg", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HGPLAIN: "", HGENCODING: "utf-8" },
  });
  return stdout;
}

async function findRepository() {
  const folders = vscode.workspace.workspaceFolders || [];
  if (!folders.length) {
    throw new Error("Open a folder containing a Mercurial repository first.");
  }

  const candidates = [];
  for (const folder of folders) {
    try {
      const root = (await runHg(folder.uri.fsPath, ["root"])).trim();
      if (!candidates.some((candidate) => candidate.root === root)) {
        candidates.push({ name: folder.name, root });
      }
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error("The hg executable was not found on PATH.");
      }
      // This workspace folder is not a Mercurial repository.
    }
  }

  if (!candidates.length) {
    throw new Error("No Mercurial repository was found in this workspace.");
  }
  if (candidates.length === 1) {
    return candidates[0].root;
  }

  const selected = await vscode.window.showQuickPick(
    candidates.map((candidate) => ({
      label: candidate.name,
      description: candidate.root,
      root: candidate.root,
    })),
    { placeHolder: "Choose a Mercurial repository" },
  );
  return selected && selected.root;
}

function setting(key, fallback) {
  const config = vscode.workspace.getConfiguration("hgGraph");
  const info = config.inspect(key);
  const userSet =
    info &&
    [info.globalValue, info.workspaceValue, info.workspaceFolderValue].some(
      (value) => value !== undefined,
    );
  return userSet
    ? config.get(key, fallback)
    : vscode.workspace.getConfiguration("mercurialTopicMap").get(key, fallback);
}

async function readGraph(root, extraPages = 0) {
  const pageSize = setting("maxCommits", 500);
  const limit = pageSize * (1 + extraPages);
  const laneWidth = setting("laneWidth", 40);
  const detailsLocation = setting("detailsLocation", "inline");
  const template = [
    "{rev}",
    "{node}",
    "{p1rev}",
    "{p2rev}",
    "{topic}",
    "{phase}",
    "{author|person}",
    "{date|isodatesec}",
    "{branch}",
    "{desc}",
  ].join("\\x1f") + "\\x1e";

  const [raw, currentRaw] = await Promise.all([
    runHg(root, [
      "log",
      "-r",
      "sort(all(), -rev)",
      "-l",
      String(limit + 1),
      "-T",
      template,
    ]),
    runHg(root, ["log", "-r", ".", "-T", "{rev}\\x1f{node}\\x1f{topic}"]),
  ]);

  const commits = raw
    .split(RECORD)
    .filter(Boolean)
    .map((record) => {
      const [rev, node, p1rev, p2rev, topic, phase, author, date, branch, description] =
        record.split(FIELD);
      return {
        rev: Number(rev),
        node,
        shortNode: node.slice(0, 12),
        parents: [Number(p1rev), Number(p2rev)].filter((parent) => parent >= 0),
        topic: topic || "",
        branch: branch || "default",
        phase,
        author,
        date,
        description,
      };
    });

  const hasMore = commits.length > limit;
  const loaded = commits.slice(0, limit);
  const olderTopics = hasMore ? await readOlderTopics(root, loaded[loaded.length - 1].rev) : [];
  const [currentRev, currentNode, currentTopic] = currentRaw.split(FIELD);
  return {
    root,
    laneWidth,
    detailsLocation,
    pageSize,
    hasMore,
    olderTopics,
    commits: loaded,
    current: {
      rev: Number(currentRev),
      node: currentNode,
      topic: currentTopic || "",
    },
  };
}

// Topics that have changesets older than the oldest loaded one, or null when
// this cannot be determined (for example without the topic extension).
async function readOlderTopics(root, oldestLoadedRev) {
  try {
    const output = await runHg(root, [
      "log",
      "-r",
      `topic() and :${oldestLoadedRev - 1}`,
      "-T",
      "{topic}\\n",
    ]);
    return [...new Set(output.split("\n").filter(Boolean))];
  } catch {
    return null;
  }
}

class GraphPanel {
  constructor() {
    this.panel = undefined;
    this.root = undefined;
    this.viewState = undefined;
    this.extraPages = 0;
    this.refreshId = 0;
    this.panelDisposables = [];
  }

  async open() {
    const root = await findRepository();
    if (!root) {
      return;
    }
    if (root !== this.root) {
      this.viewState = undefined;
      this.extraPages = 0;
    }
    this.root = root;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "hgGraph",
        "Hg Graph",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panelDisposables.push(
        this.panel.onDidDispose(() => {
          this.panel = undefined;
          this.viewState = undefined;
          this.extraPages = 0;
          for (const disposable of this.panelDisposables.splice(0)) {
            disposable.dispose();
          }
        }),
        this.panel.webview.onDidReceiveMessage(async (message) => {
          if (message.type === "refresh") {
            this.viewState = message.state;
            await this.refresh();
          } else if (message.type === "loadMore") {
            this.viewState = message.state;
            this.extraPages++;
            await this.refresh({ quiet: true });
          } else if (message.type === "copy") {
            await vscode.env.clipboard.writeText(message.value);
            vscode.window.setStatusBarMessage("Copied changeset hash", 1500);
          } else if (message.type === "files") {
            await this.sendChangedFiles(message.rev);
          } else if (message.type === "diff") {
            await openDiff(this.root, message);
          }
        }),
      );
    }

    this.panel.title = `Hg Graph — ${path.basename(root)}`;
    await this.refresh();
  }

  async refresh({ quiet = false } = {}) {
    if (!this.panel || !this.root) {
      return;
    }
    const refreshId = ++this.refreshId;
    if (!quiet) {
      this.panel.webview.html = loadingHtml();
    }
    let html;
    try {
      const data = await readGraph(this.root, this.extraPages);
      html = graphHtml(data, this.viewState);
    } catch (error) {
      html = errorHtml(error.message || String(error));
    }
    if (this.panel && refreshId === this.refreshId) {
      this.panel.webview.html = html;
    }
  }

  async sendChangedFiles(rev) {
    let files = [];
    let error;
    try {
      files = await changedFiles(this.root, rev);
    } catch (caught) {
      error = caught.message || String(caught);
    }
    if (this.panel) {
      this.panel.webview.postMessage({ type: "files", rev, files, error });
    }
  }

  dispose() {
    if (this.panel) {
      this.panel.dispose();
    }
  }
}

const CONTENT_SCHEME = "hg-graph";

function revisionUri(root, rev, file) {
  return vscode.Uri.from({
    scheme: CONTENT_SCHEME,
    path: `/${file}`,
    query: JSON.stringify({ root, rev }),
  });
}

const revisionContentProvider = {
  async provideTextDocumentContent(uri) {
    const { root, rev } = JSON.parse(uri.query);
    if (rev == null) {
      return "";
    }
    try {
      return await runHg(root, ["cat", "-r", String(rev), `path:${uri.path.slice(1)}`]);
    } catch {
      // The file does not exist at this revision (added or removed).
      return "";
    }
  },
};

async function changedFiles(root, rev) {
  const [statusOutput, stats] = await Promise.all([
    runHg(root, ["status", "--change", String(rev)]),
    runHg(root, ["diff", "--git", "-c", String(rev)])
      .then(diffStats)
      .catch(() => new Map()),
  ]);
  return statusOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const file = { status: line[0], path: line.slice(2) };
      return { ...file, ...stats.get(file.path) };
    });
}

function diffStats(diff) {
  const stats = new Map();
  let current;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git a/")) {
      // "diff --git a/<path> b/<path>": both halves are equal unless renamed.
      const length = (line.length - 16) / 2;
      const oldPath = line.slice(13, 13 + length);
      const newPath = line.slice(16 + length);
      current = { added: 0, deleted: 0, binary: false };
      stats.set(oldPath === newPath ? oldPath : newPath, current);
      inHunk = false;
    } else if (!current) {
      continue;
    } else if (!inHunk && line.startsWith("rename to ")) {
      stats.set(line.slice("rename to ".length), current);
    } else if (!inHunk && line.startsWith("copy to ")) {
      stats.set(line.slice("copy to ".length), current);
    } else if (line === "GIT binary patch" || line.startsWith("Binary file")) {
      current.binary = true;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      current.added++;
    } else if (inHunk && line.startsWith("-")) {
      current.deleted++;
    }
  }
  return stats;
}

async function openDiff(root, { rev, parent, label, parentLabel, path: file }) {
  const left = revisionUri(root, parent == null ? null : parent, file);
  const right = revisionUri(root, rev, file);
  const title = `${path.basename(file)} (${parentLabel || "empty"} ↔ ${label})`;
  await vscode.commands.executeCommand("vscode.diff", left, right, title, {
    preview: true,
  });
}

function nonce() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () =>
    chars.charAt(Math.floor(Math.random() * chars.length)),
  ).join("");
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadingHtml() {
  return `<!doctype html><html><body style="color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);padding:24px">Loading Mercurial graph…</body></html>`;
}

function errorHtml(message) {
  return `<!doctype html><html><body style="color:var(--vscode-errorForeground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);padding:24px"><h3>Hg Graph</h3><p>${escapeHtml(message)}</p></body></html>`;
}

function graphHtml(data, viewState) {
  const scriptNonce = nonce();
  const encodedData = JSON.stringify(data).replaceAll("<", "\\u003c");
  const encodedState = JSON.stringify(viewState || null).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${scriptNonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { --row-height: 62px; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-editor-background); font: 13px var(--vscode-font-family); overflow: hidden; }
    header { height: 48px; display: flex; align-items: center; gap: 10px; padding: 8px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
    header strong { white-space: nowrap; }
    select, input, button { color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; height: 28px; padding: 0 8px; }
    input { min-width: 180px; flex: 1; }
    button { cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
    button:hover { background: var(--vscode-button-secondaryHoverBackground); }
    #summary { color: var(--vscode-descriptionForeground); white-space: nowrap; }
    #main { display: grid; grid-template-columns: minmax(520px, 1fr) 300px; height: calc(100vh - 48px); }
    #scroll { overflow: auto; position: relative; }
    #map { position: relative; min-width: 100%; }
    #edges { position: absolute; inset: 0 auto auto 0; pointer-events: none; z-index: 3; }
    #rows { position: relative; z-index: 2; }
    .dot { stroke: var(--vscode-editor-background); stroke-width: 2; }
    .row { height: var(--row-height); display: flex; align-items: center; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 45%, transparent); cursor: pointer; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.current { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .graph-cell { height: 100%; flex: none; position: relative; }
    .meta { flex: 1; width: 0; min-width: 700px; display: grid; grid-template-columns: minmax(280px, 1fr) 200px 210px; align-items: center; gap: 18px; padding: 6px 14px 6px 0; }
    .description { display: -webkit-box; overflow: hidden; white-space: normal; line-height: 18px; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
    .topic { width: fit-content; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-symbolIcon-classForeground); background: color-mix(in srgb, currentColor 12%, transparent); border-radius: 10px; padding: 3px 8px; }
    .topic.default-topic { color: var(--vscode-charts-green); font-weight: 600; }
    .topic-meta, .author-meta { min-width: 0; line-height: 18px; }
    .short-hash { margin-top: 2px; padding-left: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font: 12px var(--vscode-editor-font-family); }
    .author { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); }
    .date { margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .current .short-hash, .current .author, .current .date { color: inherit; }
    .current .short-hash, .current .date { opacity: .8; }
    aside { border-left: 1px solid var(--vscode-panel-border); padding: 16px; overflow: auto; }
    aside h3 { margin: 0 0 16px; font-size: 14px; }
    .detail-fields { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 4px 12px; align-items: baseline; }
    .detail-fields .detail-label, .detail-fields .detail-value { margin-top: 0; }
    .detail-message { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--vscode-panel-border); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 19px; }
    .detail-label { color: var(--vscode-descriptionForeground); margin-top: 14px; font-size: 11px; text-transform: uppercase; }
    .detail-value { margin-top: 4px; overflow-wrap: anywhere; }
    .hash { font-family: var(--vscode-editor-font-family); cursor: pointer; }
    .empty { padding: 30px; color: var(--vscode-descriptionForeground); }
    .load-more { position: sticky; left: 0; width: min(100%, 100vw); display: flex; align-items: center; justify-content: center; }
    .load-more button { height: 30px; padding: 0 16px; }
    .load-more button:disabled { cursor: default; opacity: .7; }
    .file { display: flex; gap: 8px; align-items: baseline; padding: 2px 4px; margin: 0 -4px; border-radius: 2px; cursor: pointer; }
    .file:hover { background: var(--vscode-list-hoverBackground); }
    .file-status { flex: none; width: 12px; font: 12px var(--vscode-editor-font-family); font-weight: 600; }
    .file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .file-stats { flex: none; display: flex; gap: 6px; font: 12px var(--vscode-editor-font-family); color: var(--vscode-descriptionForeground); }
    .stat-added { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .stat-deleted { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    .status-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
    .status-A { color: var(--vscode-gitDecoration-addedResourceForeground); }
    .status-R { color: var(--vscode-gitDecoration-deletedResourceForeground); }
    body.inline-mode #main { grid-template-columns: 1fr; }
    body.inline-mode aside { display: none; }
    .row.expanded:not(.current) { background: var(--vscode-list-inactiveSelectionBackground); color: var(--vscode-list-inactiveSelectionForeground, inherit); }
    .inline-details { display: flex; overflow: hidden; border-bottom: 1px solid var(--vscode-panel-border); }
    .inline-graph { flex: none; }
    .inline-body { position: relative; flex: 1; min-width: 700px; display: grid; grid-template-columns: minmax(280px, 1fr) minmax(320px, 1fr); gap: 24px; padding: 14px 40px 14px 16px; background: var(--vscode-editorWidget-background, var(--vscode-sideBar-background)); border-left: 1px solid var(--vscode-panel-border); }
    .inline-info, .inline-files { min-width: 0; min-height: 0; overflow: auto; }
    .inline-files > .detail-label { margin-top: 0; }
    .inline-close { position: absolute; top: 8px; right: 8px; width: 24px; height: 24px; padding: 0; line-height: 22px; text-align: center; background: transparent; color: var(--vscode-descriptionForeground); border: none; font-size: 16px; }
    .inline-close:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    @media (max-width: 850px) { #main { grid-template-columns: 1fr; } aside { display: none; } .meta { min-width: 560px; grid-template-columns: minmax(220px, 1fr) 150px 170px; gap: 10px; } }
  </style>
</head>
<body>
  <header>
    <strong>Hg Graph</strong>
    <select id="topic"></select>
    <input id="search" type="search" placeholder="Filter commits, authors, hashes…">
    <span id="summary"></span>
    <button id="refresh" title="Reload from Mercurial">Refresh</button>
  </header>
  <div id="main">
    <div id="scroll"><div id="map"><svg id="edges"></svg><div id="rows"></div></div></div>
    <aside id="details"><h3>Changeset details</h3><div>Select a changeset.</div></aside>
  </div>
  <script nonce="${scriptNonce}">
    const vscode = acquireVsCodeApi();
    const data = ${encodedData};
    const savedState = ${encodedState};
    const DEFAULT_COLOR = 'var(--vscode-charts-green)';
    const TOPIC_COLORS = [
      '#4ea1ff', '#ff8c42', '#b084f5', '#ff5c77',
      '#35bfe7', '#e66bd4', 'var(--vscode-editor-foreground)',
      '#7c8cff', '#ff7f6e', '#74c0fc', '#d080ff',
      '#ff70a6', '#9fa8da', '#bcaaa4', '#80bfff', '#c77dff', '#c6ff00'
    ];
    const topicColorByName = new Map(
      [...new Set(data.commits.map(topicName).filter(name => name !== 'default'))]
        .sort((a, b) => a.localeCompare(b))
        .map((topic, index) => [topic, TOPIC_COLORS[index % TOPIC_COLORS.length]])
    );
    const topicSelect = document.getElementById('topic');
    const search = document.getElementById('search');
    const rows = document.getElementById('rows');
    const svg = document.getElementById('edges');
    const map = document.getElementById('map');
    const details = document.getElementById('details');
    const summary = document.getElementById('summary');
    const scroll = document.getElementById('scroll');
    const ROW_HEIGHT = 62;
    const LOAD_MORE_HEIGHT = 64;
    const LANE_WIDTH = data.laneWidth;
    const GRAPH_PADDING = 24;
    const DETAILS_HEIGHT = 280;
    const INLINE = data.detailsLocation !== 'side';
    let selectedRev = savedState ? savedState.selectedRev : null;
    let detailsRev = null;
    let filesContainer = null;
    let expandedRow = null;
    const filesByRev = new Map();
    if (INLINE) document.body.classList.add('inline-mode');

    function text(value) {
      const span = document.createElement('span');
      span.textContent = value == null ? '' : String(value);
      return span.innerHTML.replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    }

    function topicName(commit) {
      return commit.topic || commit.branch;
    }

    function commitSummary(commit) {
      const description = commit.description || '';
      const blankLine = description.search(/\\n[ \\t]*\\n/);
      return blankLine >= 0 ? description.slice(0, blankLine) : description;
    }

    function commitColor(commit) {
      const name = topicName(commit);
      return name === 'default' ? DEFAULT_COLOR : topicColorByName.get(name);
    }

    const loadedRevs = new Set(data.commits.map(commit => commit.rev));
    const mainline = new Set();
    {
      const allByRev = new Map(data.commits.map(commit => [commit.rev, commit]));
      let commit = data.commits.find(candidate => topicName(candidate) === 'default');
      // Follow the first parent that is itself on default, so a merge whose
      // first parent is a topic changeset keeps the default line in lane 0.
      while (commit && !mainline.has(commit.rev)) {
        mainline.add(commit.rev);
        commit = commit.parents
          .map(parent => allByRev.get(parent))
          .find(parent => parent && topicName(parent) === 'default');
      }
    }

    const counts = new Map();
    for (const commit of data.commits) {
      const key = topicName(commit);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    topicSelect.innerHTML = '<option value="">All topics</option>' +
      [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, count]) => '<option value="' + text(name) + '">' + text(name) + ' (' + count + ')</option>').join('');
    if (savedState) {
      if (savedState.topic === '' || counts.has(savedState.topic)) topicSelect.value = savedState.topic;
      search.value = savedState.search || '';
    }

    function visibleCommits() {
      const topic = topicSelect.value;
      const query = search.value.trim().toLowerCase();
      return data.commits.filter(commit => {
        if (topic && topicName(commit) !== topic) return false;
        if (!query) return true;
        return [commit.rev, commit.node, commit.topic, commit.branch, commit.author, commit.description, commit.phase]
          .some(value => String(value || '').toLowerCase().includes(query));
      });
    }

    // Each lane holds a pending edge { child, parent } that runs straight down
    // until the parent row, so edges never share a lane with other commits.
    function layout(commits) {
      const reserveDefaultLane = topicSelect.value === '';
      const firstTopicLane = reserveDefaultLane ? 1 : 0;
      const lanes = reserveDefaultLane ? [null] : [];
      const positions = new Map();
      const edges = [];
      const commitsByRev = new Map(commits.map(commit => [commit.rev, commit]));
      let laneCount = 1;

      function allocateLane(preferred) {
        if (preferred != null && preferred >= firstTopicLane && lanes[preferred] == null) return preferred;
        for (let lane = firstTopicLane; lane < lanes.length; lane++) {
          if (lanes[lane] == null) return lane;
        }
        return lanes.length;
      }

      function isDefaultLaneCommit(commit) {
        return reserveDefaultLane && mainline.has(commit.rev);
      }

      for (let row = 0; row < commits.length; row++) {
        const commit = commits[row];
        let lane;
        if (isDefaultLaneCommit(commit)) {
          lane = 0;
          if (lanes[0] && lanes[0].parent !== commit.rev) {
            const moved = allocateLane();
            lanes[moved] = lanes[0];
            lanes[0] = null;
          }
        } else {
          lane = lanes.findIndex((edge, index) => index >= firstTopicLane && edge && edge.parent === commit.rev);
          if (lane < 0) lane = allocateLane();
        }
        positions.set(commit.rev, { lane, row });

        lanes.forEach((edge, index) => {
          if (edge && edge.parent === commit.rev) {
            edges.push({ child: edge.child, parent: commit.rev, lane: index });
            lanes[index] = null;
          }
        });

        commit.parents.forEach((parentRev, index) => {
          const parent = commitsByRev.get(parentRev);
          const edge = { child: commit.rev, parent: parentRev };
          if (!parent && loadedRevs.has(parentRev)) {
            edges.push({ ...edge, lane, stub: true });
            return;
          }
          if (!parent) {
            const target = index === 0 && isDefaultLaneCommit(commit) && lanes[0] == null
              ? 0
              : allocateLane(index === 0 ? lane : lane + 1);
            lanes[target] = edge;
            return;
          }
          if (index === 0) {
            const target = isDefaultLaneCommit(commit) && isDefaultLaneCommit(parent) && lanes[0] == null
              ? 0
              : allocateLane(lane);
            lanes[target] = edge;
            return;
          }
          const shared = lanes.findIndex(pending => pending && pending.parent === parentRev);
          if (shared >= 0) {
            edges.push({ ...edge, lane: shared });
          } else {
            lanes[allocateLane(lane + 1)] = edge;
          }
        });

        laneCount = Math.max(laneCount, lanes.length, lane + 1);
        while (lanes.length > firstTopicLane && lanes[lanes.length - 1] == null) lanes.pop();
      }
      lanes.forEach((edge, index) => {
        if (edge) edges.push({ child: edge.child, parent: edge.parent, lane: index, offscreen: true });
      });
      return { positions, edges, laneCount };
    }

    function laneX(lane) {
      return GRAPH_PADDING + lane * LANE_WIDTH;
    }

    function gapAfter(row) {
      return row === expandedRow ? DETAILS_HEIGHT : 0;
    }

    function rowY(row) {
      const offset = expandedRow != null && row > expandedRow ? DETAILS_HEIGHT : 0;
      return row * ROW_HEIGHT + 31 + offset;
    }

    function curve(x1, y1, x2, y2) {
      const middle = (y1 + y2) / 2;
      return ' C ' + x1 + ' ' + middle + ', ' + x2 + ' ' + middle + ', ' + x2 + ' ' + y2;
    }

    // Bends only happen over a single row height, so lines run straight
    // down through an open inline details panel.
    function edgePath(source, target, lane) {
      const x1 = laneX(source.lane);
      const y1 = rowY(source.row);
      const xs = target.row - source.row > 1 ? laneX(lane) : x1;
      const x2 = laneX(target.lane);
      const y2 = rowY(target.row);
      let d = 'M ' + x1 + ' ' + y1;
      let y = y1;
      if (xs !== x1) {
        const start = y1 + gapAfter(source.row);
        if (start > y) d += ' L ' + x1 + ' ' + start;
        d += curve(x1, start, xs, start + ROW_HEIGHT);
        y = start + ROW_HEIGHT;
      }
      const yEnd = xs !== x2 ? y2 - ROW_HEIGHT : y2;
      if (yEnd > y) d += ' L ' + xs + ' ' + yEnd;
      if (xs !== x2) d += curve(xs, Math.max(y, yEnd), x2, y2);
      return d;
    }

    function detailsInfoHtml(commit) {
      return '<div class="detail-fields">' +
          '<div class="detail-label">Changeset</div><div class="detail-value hash" title="Click to copy">' + text(commit.rev + ':' + commit.node) + '</div>' +
          '<div class="detail-label">Parents</div><div class="detail-value">' + text(commit.parents.join(', ') || 'none') + '</div>' +
          '<div class="detail-label">Author</div><div class="detail-value">' + text(commit.author) + '</div>' +
          '<div class="detail-label">Date</div><div class="detail-value">' + text(commit.date) + '</div>' +
          '<div class="detail-label">Topic</div><div class="detail-value">' + text(topicName(commit)) + '</div>' +
          '<div class="detail-label">Phase</div><div class="detail-value">' + text(commit.phase) + '</div>' +
        '</div>' +
        '<div class="detail-message">' + text(commit.description) + '</div>';
    }

    const FILES_HTML = '<div class="detail-label">Changed files</div><div class="detail-value files"></div>';

    function bindDetails(container, commit) {
      container.querySelector('.hash').addEventListener('click', () =>
        vscode.postMessage({ type: 'copy', value: commit.node }));
      detailsRev = commit.rev;
      filesContainer = container.querySelector('.files');
      if (filesByRev.has(commit.rev)) {
        renderFiles(commit, filesByRev.get(commit.rev));
      } else {
        filesContainer.textContent = 'Loading…';
        vscode.postMessage({ type: 'files', rev: commit.rev });
      }
    }

    function showDetails(commit) {
      details.innerHTML = detailsInfoHtml(commit) + FILES_HTML;
      bindDetails(details, commit);
    }

    function inlineDetails(commit, graphWidth) {
      const panel = document.createElement('div');
      panel.className = 'inline-details';
      panel.style.height = DETAILS_HEIGHT + 'px';
      panel.innerHTML =
        '<div class="inline-graph" style="width:' + graphWidth + 'px"></div>' +
        '<div class="inline-body">' +
          '<div class="inline-info">' + detailsInfoHtml(commit) + '</div>' +
          '<div class="inline-files">' + FILES_HTML + '</div>' +
          '<button class="inline-close" title="Close (Esc)">\u00d7</button>' +
        '</div>';
      panel.querySelector('.inline-close').addEventListener('click', closeInlineDetails);
      bindDetails(panel, commit);
      return panel;
    }

    function closeInlineDetails() {
      if (!INLINE || selectedRev == null) return;
      selectedRev = null;
      render();
    }

    function shortLabel(rev) {
      const commit = data.commits.find(candidate => candidate.rev === rev);
      return commit ? commit.shortNode : String(rev);
    }

    function fileStats(file) {
      if (file.binary) return '<span class="file-stats">bin</span>';
      if (file.added == null) return '';
      return '<span class="file-stats">' +
        (file.added ? '<span class="stat-added">+' + file.added + '</span>' : '') +
        (file.deleted ? '<span class="stat-deleted">\u2212' + file.deleted + '</span>' : '') +
        '</span>';
    }

    function renderFiles(commit, result) {
      const container = filesContainer;
      if (!container) return;
      if (result.error) {
        container.textContent = result.error;
        return;
      }
      if (!result.files.length) {
        container.textContent = 'No file changes.';
        return;
      }
      container.innerHTML = '';
      const parent = commit.parents.length ? commit.parents[0] : null;
      for (const file of result.files) {
        const entry = document.createElement('div');
        entry.className = 'file';
        entry.title = file.path + ' (click to diff against parent)';
        entry.innerHTML =
          '<span class="file-status status-' + text(file.status) + '">' + text(file.status) + '</span>' +
          '<span class="file-path">' + text(file.path) + '</span>' +
          fileStats(file);
        entry.addEventListener('click', () => vscode.postMessage({
          type: 'diff',
          rev: commit.rev,
          parent,
          label: commit.shortNode,
          parentLabel: parent == null ? null : shortLabel(parent),
          path: file.path,
        }));
        container.appendChild(entry);
      }
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type !== 'files') return;
      filesByRev.set(message.rev, message);
      if (message.rev === detailsRev) {
        const commit = data.commits.find(candidate => candidate.rev === message.rev);
        if (commit) renderFiles(commit, message);
      }
    });

    function render() {
      const commits = visibleCommits();
      const { positions, edges, laneCount } = layout(commits);
      const graphWidth = Math.max(140, (laneCount - 1) * LANE_WIDTH + GRAPH_PADDING * 2);
      const width = Math.max(scroll.clientWidth, graphWidth + 700);
      expandedRow = null;
      if (INLINE) {
        detailsRev = null;
        filesContainer = null;
        const index = commits.findIndex(commit => commit.rev === selectedRev);
        if (index >= 0) expandedRow = index;
      }
      const height = commits.length * ROW_HEIGHT + (expandedRow != null ? DETAILS_HEIGHT : 0);
      map.style.width = width + 'px';
      map.style.height = (height + (needsLoadMore() ? LOAD_MORE_HEIGHT : 0)) + 'px';
      svg.setAttribute('width', graphWidth);
      svg.setAttribute('height', height);
      svg.innerHTML = '';
      rows.innerHTML = '';
      summary.textContent = commits.length + ' changesets';

      if (!commits.length) {
        rows.innerHTML = '<div class="empty">No matching changesets.</div>';
        appendLoadMore();
        return;
      }

      const ns = 'http://www.w3.org/2000/svg';
      const commitsByRev = new Map(commits.map(commit => [commit.rev, commit]));
      for (const edge of edges) {
        const source = positions.get(edge.child);
        const path = document.createElementNS(ns, 'path');
        if (edge.stub) {
          const x = laneX(source.lane);
          const y = rowY(source.row);
          path.setAttribute('d', 'M ' + x + ' ' + y + ' L ' + x + ' ' + (y + gapAfter(source.row) + Math.round(ROW_HEIGHT * 0.6)));
          path.setAttribute('stroke-dasharray', '3 3');
        } else {
          const target = edge.offscreen ? { lane: edge.lane, row: commits.length } : positions.get(edge.parent);
          path.setAttribute('d', edgePath(source, target, edge.lane));
        }
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', commitColor(commitsByRev.get(edge.child)));
        path.setAttribute('stroke-width', '2');
        svg.appendChild(path);
      }

      for (const commit of commits) {
        const position = positions.get(commit.rev);
        const dot = document.createElementNS(ns, 'circle');
        dot.setAttribute('class', 'dot');
        dot.setAttribute('cx', laneX(position.lane));
        dot.setAttribute('cy', rowY(position.row));
        dot.setAttribute('r', '5');
        dot.style.fill = commitColor(commit);
        svg.appendChild(dot);
      }

      commits.forEach(commit => {
        const position = positions.get(commit.rev);
        const color = commitColor(commit);
        const row = document.createElement('div');
        row.className = 'row' +
          (commit.rev === data.current.rev ? ' current' : '') +
          (position.row === expandedRow ? ' expanded' : '');
        const graph = document.createElement('div');
        graph.className = 'graph-cell';
        graph.style.width = graphWidth + 'px';
        row.appendChild(graph);

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.innerHTML =
          '<span class="description" title="' + text(commit.description) + '">' + text(commitSummary(commit)) + '</span>' +
          '<span class="topic-meta">' +
            '<div class="topic' + (topicName(commit) === 'default' ? ' default-topic' : '') + '" style="color:' + color + '" title="' + text(topicName(commit)) + '">' + text(topicName(commit)) + '</div>' +
            '<div class="short-hash" title="' + text(commit.rev + ':' + commit.node) + '">' + text(commit.rev + ':' + commit.shortNode) + '</div>' +
          '</span>' +
          '<span class="author-meta">' +
            '<div class="author" title="' + text(commit.author) + '">' + text(commit.author) + '</div>' +
            '<div class="date" title="' + text(commit.date) + '">' + text(commit.date.slice(0, 10)) + '</div>' +
          '</span>';
        row.appendChild(meta);
        row.addEventListener('click', () => {
          if (INLINE) {
            selectedRev = selectedRev === commit.rev ? null : commit.rev;
            render();
            const panel = rows.querySelector('.inline-details');
            if (panel) panel.scrollIntoView({ block: 'nearest' });
          } else {
            selectedRev = commit.rev;
            showDetails(commit);
          }
        });
        rows.appendChild(row);
        if (position.row === expandedRow) {
          rows.appendChild(inlineDetails(commit, graphWidth));
        }
      });
      appendLoadMore();

      if (!INLINE) {
        const selected = commits.find(commit => commit.rev === selectedRev)
          || commits.find(commit => commit.rev === data.current.rev)
          || commits[0];
        showDetails(selected);
      }
    }

    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeInlineDetails();
    });

    topicSelect.addEventListener('change', render);
    search.addEventListener('input', render);
    const loadedTopics = new Set(data.commits.map(commit => commit.topic).filter(Boolean));

    function needsLoadMore() {
      if (!data.hasMore) return false;
      const selected = topicSelect.value;
      if (!selected || !data.olderTopics || !loadedTopics.has(selected)) return true;
      return data.olderTopics.includes(selected);
    }

    function appendLoadMore() {
      if (!needsLoadMore()) return;
      const container = document.createElement('div');
      container.className = 'load-more';
      container.style.height = LOAD_MORE_HEIGHT + 'px';
      const button = document.createElement('button');
      button.textContent = 'Load more changesets';
      button.title = 'Load ' + data.pageSize + ' older changesets';
      button.addEventListener('click', () => {
        button.disabled = true;
        button.textContent = 'Loading…';
        vscode.postMessage({ type: 'loadMore', state: currentViewState() });
      });
      container.appendChild(button);
      rows.appendChild(container);
    }

    function currentViewState() {
      return {
        topic: topicSelect.value,
        search: search.value,
        selectedRev,
        scrollTop: scroll.scrollTop,
      };
    }

    document.getElementById('refresh').addEventListener('click', () =>
      vscode.postMessage({ type: 'refresh', state: currentViewState() }));
    window.addEventListener('resize', render);
    render();
    if (savedState) {
      scroll.scrollTop = savedState.scrollTop || 0;
    } else {
      const currentRow = visibleCommits().findIndex(commit => commit.rev === data.current.rev);
      if (currentRow > 0) {
        scroll.scrollTop = Math.max(0, currentRow * ROW_HEIGHT - (scroll.clientHeight - ROW_HEIGHT) / 2);
      }
    }
  </script>
</body>
</html>`;
}

function activate(context) {
  const graphPanel = new GraphPanel();
  context.subscriptions.push(
    graphPanel,
    vscode.workspace.registerTextDocumentContentProvider(CONTENT_SCHEME, revisionContentProvider),
    vscode.commands.registerCommand("hgGraph.open", async () => {
      try {
        await graphPanel.open();
      } catch (error) {
        vscode.window.showErrorMessage(error.message || String(error));
      }
    }),
  );

  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = "$(git-branch) Hg Graph";
  statusBarItem.tooltip = "Open Hg Graph";
  statusBarItem.command = "hgGraph.open";

  let hasRepository = false;
  const updateStatusBarItem = () => {
    if (hasRepository && setting("showStatusBarItem", true)) {
      statusBarItem.show();
    } else {
      statusBarItem.hide();
    }
  };
  const detectRepository = async () => {
    const folders = vscode.workspace.workspaceFolders || [];
    const results = await Promise.all(
      folders.map((folder) =>
        runHg(folder.uri.fsPath, ["root"]).then(() => true, () => false),
      ),
    );
    hasRepository = results.some(Boolean);
    updateStatusBarItem();
  };

  context.subscriptions.push(
    statusBarItem,
    vscode.workspace.onDidChangeWorkspaceFolders(detectRepository),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("hgGraph.showStatusBarItem")) {
        updateStatusBarItem();
      }
      if (
        event.affectsConfiguration("hgGraph.detailsLocation") ||
        event.affectsConfiguration("hgGraph.laneWidth")
      ) {
        graphPanel.refresh();
      }
    }),
  );
  detectRepository();
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  // Exposed for the tests in test/.
  _internal: {
    readGraph,
    changedFiles,
    diffStats,
    revisionContentProvider,
    escapeHtml,
    errorHtml,
    graphHtml,
    GraphPanel,
  },
};
