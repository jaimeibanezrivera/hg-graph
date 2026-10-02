const vscode = require("vscode");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);
const FIELD = "\x1f";
const RECORD = "\x1e";

async function runHg(cwd, args) {
  const { stdout } = await execFileAsync("hg", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HGPLAIN: "" },
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
    } catch {
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

async function readGraph(root) {
  const limit = vscode.workspace
    .getConfiguration("mercurialTopicMap")
    .get("maxCommits", 500);
  const template = [
    "{rev}",
    "{node}",
    "{p1rev}",
    "{p2rev}",
    "{topic}",
    "{phase}",
    "{author|person}",
    "{date|isodatesec}",
    "{desc|firstline}",
  ].join("\\x1f") + "\\x1e";

  const [raw, currentRaw] = await Promise.all([
    runHg(root, [
      "log",
      "-r",
      "sort(all(), -rev)",
      "-l",
      String(limit),
      "-T",
      template,
    ]),
    runHg(root, ["log", "-r", ".", "-T", "{rev}\\x1f{node}\\x1f{topic}"]),
  ]);

  const commits = raw
    .split(RECORD)
    .filter(Boolean)
    .map((record) => {
      const [rev, node, p1rev, p2rev, topic, phase, author, date, description] =
        record.split(FIELD);
      return {
        rev: Number(rev),
        node,
        shortNode: node.slice(0, 12),
        parents: [Number(p1rev), Number(p2rev)].filter((parent) => parent >= 0),
        topic: topic || "",
        phase,
        author,
        date,
        description,
      };
    });

  const [currentRev, currentNode, currentTopic] = currentRaw.split(FIELD);
  return {
    root,
    commits,
    current: {
      rev: Number(currentRev),
      node: currentNode,
      topic: currentTopic || "",
    },
  };
}

class TopicMapPanel {
  constructor(context) {
    this.context = context;
    this.panel = undefined;
    this.root = undefined;
  }

  async open() {
    const root = await findRepository();
    if (!root) {
      return;
    }
    this.root = root;

    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel(
        "mercurialTopicMap",
        "Mercurial Topic Map",
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.panel.onDidDispose(() => {
        this.panel = undefined;
      });
      this.panel.webview.onDidReceiveMessage(async (message) => {
        if (message.type === "refresh") {
          await this.refresh();
        } else if (message.type === "copy") {
          await vscode.env.clipboard.writeText(message.value);
          vscode.window.setStatusBarMessage("Copied changeset hash", 1500);
        }
      });
    }

    this.panel.title = `Topic Map — ${root.split("/").pop()}`;
    await this.refresh();
  }

  async refresh() {
    if (!this.panel || !this.root) {
      return;
    }
    this.panel.webview.html = loadingHtml();
    try {
      const data = await readGraph(this.root);
      this.panel.webview.html = graphHtml(data);
    } catch (error) {
      this.panel.webview.html = errorHtml(error.message || String(error));
    }
  }
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
  return `<!doctype html><html><body style="color:var(--vscode-errorForeground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);padding:24px"><h3>Mercurial Topic Map</h3><p>${escapeHtml(message)}</p></body></html>`;
}

function graphHtml(data) {
  const scriptNonce = nonce();
  const encodedData = JSON.stringify(data).replaceAll("<", "\\u003c");
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
    #edges { position: absolute; inset: 0 auto auto 0; pointer-events: none; z-index: 1; }
    #rows { position: relative; z-index: 2; }
    .row { height: var(--row-height); display: flex; align-items: center; border-bottom: 1px solid color-mix(in srgb, var(--vscode-panel-border) 45%, transparent); cursor: pointer; }
    .row:hover { background: var(--vscode-list-hoverBackground); }
    .row.current { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .graph-cell { height: 100%; flex: none; position: relative; }
    .dot { position: absolute; top: 25px; width: 12px; height: 12px; margin-left: -6px; border: 2px solid var(--vscode-editor-background); border-radius: 50%; }
    .meta { flex: 1; width: 0; min-width: 700px; display: grid; grid-template-columns: minmax(280px, 1fr) 200px 210px; align-items: center; gap: 18px; padding: 6px 14px 6px 0; }
    .description { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .topic { justify-self: start; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-symbolIcon-classForeground); background: color-mix(in srgb, currentColor 12%, transparent); border-radius: 10px; padding: 3px 8px; }
    .topic.default-topic { color: var(--vscode-charts-green); font-weight: 600; }

    .commit-meta { min-width: 0; line-height: 18px; }
    .rev { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-foreground); font-family: var(--vscode-editor-font-family); }
    .author { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--vscode-descriptionForeground); font-size: 12px; }
    .current .rev, .current .author { color: inherit; }
    .current .author { opacity: .8; }
    aside { border-left: 1px solid var(--vscode-panel-border); padding: 16px; overflow: auto; }
    aside h3 { margin: 0 0 16px; font-size: 14px; }
    .detail-label { color: var(--vscode-descriptionForeground); margin-top: 14px; font-size: 11px; text-transform: uppercase; }
    .detail-value { margin-top: 4px; overflow-wrap: anywhere; }
    .hash { font-family: var(--vscode-editor-font-family); cursor: pointer; }
    .empty { padding: 30px; color: var(--vscode-descriptionForeground); }
    @media (max-width: 850px) { #main { grid-template-columns: 1fr; } aside { display: none; } .meta { min-width: 560px; grid-template-columns: minmax(220px, 1fr) 150px 170px; gap: 10px; } }
  </style>
</head>
<body>
  <header>
    <strong>Mercurial Topic Map</strong>
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
    const DEFAULT_COLOR = 'var(--vscode-charts-green)';
    const topicColorByName = new Map(
      [...new Set(data.commits.map(commit => commit.topic).filter(Boolean))]
        .sort((a, b) => a.localeCompare(b))
        .map((topic, index) => {
          const hue = Math.round((205 + index * 137.508) % 360);
          const lightness = index % 2 === 0 ? 58 : 68;
          return [topic, 'hsl(' + hue + ' 72% ' + lightness + '%)'];
        })
    );
    const topicSelect = document.getElementById('topic');
    const search = document.getElementById('search');
    const rows = document.getElementById('rows');
    const svg = document.getElementById('edges');
    const map = document.getElementById('map');
    const details = document.getElementById('details');
    const summary = document.getElementById('summary');
    const ROW_HEIGHT = 62;
    const LANE_WIDTH = 22;

    function text(value) {
      const span = document.createElement('span');
      span.textContent = value == null ? '' : String(value);
      return span.innerHTML;
    }

    function topicName(commit) {
      return commit.topic || 'default';
    }

    function commitColor(commit) {
      if (!commit.topic) return DEFAULT_COLOR;
      return topicColorByName.get(commit.topic);
    }

    const counts = new Map();
    for (const commit of data.commits) {
      const key = topicName(commit);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    topicSelect.innerHTML = '<option value="">All topics</option>' +
      [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, count]) => '<option value="' + text(name) + '">' + text(name) + ' (' + count + ')</option>').join('');
    if (data.current.topic) topicSelect.value = data.current.topic;

    function visibleCommits() {
      const topic = topicSelect.value;
      const query = search.value.trim().toLowerCase();
      return data.commits.filter(commit => {
        if (topic && topicName(commit) !== topic) return false;
        if (!query) return true;
        return [commit.rev, commit.node, commit.topic, commit.author, commit.description, commit.phase]
          .some(value => String(value || '').toLowerCase().includes(query));
      });
    }

    function layout(commits) {
      const reserveDefaultLane = topicSelect.value === '';
      const firstTopicLane = reserveDefaultLane ? 1 : 0;
      const lanes = reserveDefaultLane ? [null] : [];
      const positions = new Map();
      const commitsByRev = new Map(data.commits.map(commit => [commit.rev, commit]));

      function allocateTopicLane() {
        for (let lane = firstTopicLane; lane < lanes.length; lane++) {
          if (lanes[lane] == null) return lane;
        }
        return lanes.length;
      }

      function placeParent(parentRev, preferredLane) {
        if (parentRev == null) return;
        const parent = commitsByRev.get(parentRev);
        if (reserveDefaultLane && parent && !parent.topic) {
          lanes[0] = parentRev;
          return;
        }
        if (lanes.includes(parentRev)) return;
        const lane = preferredLane >= firstTopicLane && lanes[preferredLane] == null
          ? preferredLane
          : allocateTopicLane();
        lanes[lane] = parentRev;
      }

      for (let row = 0; row < commits.length; row++) {
        const commit = commits[row];
        let lane;
        if (reserveDefaultLane && !commit.topic) {
          lane = 0;
          const duplicateLane = lanes.indexOf(commit.rev, 1);
          if (duplicateLane >= 1) lanes[duplicateLane] = null;
        } else {
          lane = lanes.indexOf(commit.rev, firstTopicLane);
          if (lane < firstTopicLane) lane = allocateTopicLane();
        }
        positions.set(commit.rev, { lane, row });
        lanes[lane] = null;
        placeParent(commit.parents[0], lane);
        placeParent(commit.parents[1], lane + 1);
        while (lanes.length > firstTopicLane && lanes[lanes.length - 1] == null) lanes.pop();
      }
      return { positions, laneCount: Math.max(1, ...[...positions.values()].map(value => value.lane + 1)) };
    }

    function showDetails(commit) {
      details.innerHTML =
        '<h3>' + text(commit.description) + '</h3>' +
        '<div class="detail-label">Topic</div><div class="detail-value">' + text(topicName(commit)) + '</div>' +
        '<div class="detail-label">Changeset</div><div class="detail-value hash" title="Click to copy">' + text(commit.rev + ':' + commit.node) + '</div>' +
        '<div class="detail-label">Author</div><div class="detail-value">' + text(commit.author) + '</div>' +
        '<div class="detail-label">Date</div><div class="detail-value">' + text(commit.date) + '</div>' +
        '<div class="detail-label">Phase</div><div class="detail-value">' + text(commit.phase) + '</div>' +
        '<div class="detail-label">Parents</div><div class="detail-value">' + text(commit.parents.join(', ') || 'none') + '</div>';
      details.querySelector('.hash').addEventListener('click', () =>
        vscode.postMessage({ type: 'copy', value: commit.node }));
    }

    function render() {
      const commits = visibleCommits();
      const { positions, laneCount } = layout(commits);
      const graphWidth = Math.max(72, laneCount * LANE_WIDTH + 28);
      const width = Math.max(document.getElementById('scroll').clientWidth, graphWidth + 700);
      const height = commits.length * ROW_HEIGHT;
      map.style.width = width + 'px';
      map.style.height = height + 'px';
      svg.setAttribute('width', graphWidth);
      svg.setAttribute('height', height);
      svg.innerHTML = '';
      rows.innerHTML = '';
      summary.textContent = commits.length + ' changesets';

      if (!commits.length) {
        rows.innerHTML = '<div class="empty">No matching changesets.</div>';
        return;
      }

      const ns = 'http://www.w3.org/2000/svg';
      for (const commit of commits) {
        const source = positions.get(commit.rev);
        for (const parentRev of commit.parents) {
          const target = positions.get(parentRev);
          if (!target) continue;
          const x1 = 18 + source.lane * LANE_WIDTH;
          const y1 = source.row * ROW_HEIGHT + 31;
          const x2 = 18 + target.lane * LANE_WIDTH;
          const y2 = target.row * ROW_HEIGHT + 31;
          const path = document.createElementNS(ns, 'path');
          const bend = Math.min(28, Math.max(10, (y2 - y1) / 2));
          path.setAttribute('d', 'M ' + x1 + ' ' + y1 + ' C ' + x1 + ' ' + (y1 + bend) + ', ' + x2 + ' ' + (y2 - bend) + ', ' + x2 + ' ' + y2);
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke', commitColor(commit));
          path.setAttribute('stroke-width', '2');
          svg.appendChild(path);
        }
      }

      commits.forEach(commit => {
        const position = positions.get(commit.rev);
        const color = commitColor(commit);
        const row = document.createElement('div');
        row.className = 'row' + (commit.rev === data.current.rev ? ' current' : '');
        const graph = document.createElement('div');
        graph.className = 'graph-cell';
        graph.style.width = graphWidth + 'px';
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.style.left = (18 + position.lane * LANE_WIDTH) + 'px';
        dot.style.background = color;
        graph.appendChild(dot);
        row.appendChild(graph);

        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.innerHTML =
          '<span class="description" title="' + text(commit.description) + '">' + text(commit.description) + '</span>' +
          '<span class="topic' + (!commit.topic ? ' default-topic' : '') + '" style="color:' + color + '" title="' + text(topicName(commit)) + '">' + text(topicName(commit)) + '</span>' +
          '<span class="commit-meta">' +
            '<div class="rev" title="' + text(commit.rev + ':' + commit.node) + '">' + text(commit.rev + ':' + commit.shortNode) + '</div>' +
            '<div class="author" title="' + text(commit.author) + '">' + text(commit.author) + '</div>' +
          '</span>';
        row.appendChild(meta);
        row.addEventListener('click', () => showDetails(commit));
        rows.appendChild(row);
      });

      const current = commits.find(commit => commit.rev === data.current.rev);
      showDetails(current || commits[0]);
    }

    topicSelect.addEventListener('change', render);
    search.addEventListener('input', render);
    document.getElementById('refresh').addEventListener('click', () =>
      vscode.postMessage({ type: 'refresh' }));
    window.addEventListener('resize', render);
    render();
  </script>
</body>
</html>`;
}

function activate(context) {
  const topicMap = new TopicMapPanel(context);
  context.subscriptions.push(
    vscode.commands.registerCommand("mercurialTopicMap.open", async () => {
      try {
        await topicMap.open();
      } catch (error) {
        vscode.window.showErrorMessage(error.message || String(error));
      }
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
