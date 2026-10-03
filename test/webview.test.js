// Renders the graph webview in jsdom and drives it like a user would.
const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const { JSDOM } = require("jsdom");
require("./helpers/vscode");
const { graphHtml, errorHtml, escapeHtml } = require("../extension")._internal;

function commit(rev, parents, fields = {}) {
  const node = String(rev).padStart(4, "0").repeat(10);
  return {
    rev,
    node,
    shortNode: node.slice(0, 12),
    parents,
    topic: "",
    branch: "default",
    phase: "draft",
    author: "Ada",
    date: `2026-01-${String(rev + 1).padStart(2, "0")} 10:00:00 +0000`,
    description: `change ${rev}`,
    ...fields,
  };
}

// 0 - 1 - 3 on default, with topic "feature" (2, 4) branching off 1.
function sampleCommits() {
  return [
    commit(4, [2], { topic: "feature", description: "feature part 2" }),
    commit(3, [1], { description: "mainline work\n\nWith a body that is not shown in the row." }),
    commit(2, [1], { topic: "feature", description: "feature part 1", author: "Grace" }),
    commit(1, [0]),
    commit(0, []),
  ];
}

function graphData(overrides = {}) {
  return {
    root: "/repo",
    laneWidth: 40,
    detailsLocation: "inline",
    pageSize: 500,
    hasMore: false,
    olderTopics: [],
    commits: sampleCommits(),
    current: { rev: 3, node: "x", topic: "" },
    ...overrides,
  };
}

function render(data = graphData(), viewState) {
  const posted = [];
  const dom = new JSDOM(graphHtml(data, viewState), {
    runScripts: "dangerously",
    beforeParse(window) {
      // Messages are serialized on their way to the extension, which also
      // moves them out of the jsdom realm for deepStrictEqual.
      window.acquireVsCodeApi = () => ({
        postMessage: (message) => posted.push(JSON.parse(JSON.stringify(message))),
      });
      window.HTMLElement.prototype.scrollIntoView = () => {};
    },
  });
  const { document } = dom.window;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  return {
    window: dom.window,
    document,
    posted,
    $,
    $$,
    rowTexts: () => $$(".row .description").map((element) => element.textContent),
    dots: () => $$("circle.dot").map((dot) => Number(dot.getAttribute("cx"))),
    setValue(selector, value, event) {
      const element = $(selector);
      element.value = value;
      element.dispatchEvent(new dom.window.Event(event, { bubbles: true }));
    },
    click: (element) => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })),
    key: (key) => document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key })),
    receive(message) {
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message }));
    },
  };
}

describe("rows", () => {
  test("renders one row per changeset and highlights the current one", () => {
    const view = render();
    assert.deepEqual(view.rowTexts(), ["feature part 2", "mainline work", "feature part 1", "change 1", "change 0"]);
    assert.equal(view.$("#summary").textContent, "5 changesets");
    const current = view.$$(".row.current");
    assert.equal(current.length, 1);
    assert.equal(current[0].querySelector(".description").textContent, "mainline work");
  });

  test("shows the summary line in the row and the full message in its tooltip", () => {
    const view = render();
    const description = view.$$(".row .description")[1];
    assert.equal(description.textContent, "mainline work");
    assert.equal(description.title, "mainline work\n\nWith a body that is not shown in the row.");
  });

  test("shows topic or branch, short hash, author and date", () => {
    const view = render();
    const [first, , , second] = view.$$(".row");
    assert.equal(first.querySelector(".topic").textContent, "feature");
    assert.equal(first.querySelector(".short-hash").textContent, "4:000400040004");
    assert.equal(first.querySelector(".date").textContent, "2026-01-05");
    assert.ok(second.querySelector(".topic").classList.contains("default-topic"));
  });

  test("escapes markup in changeset fields", () => {
    const data = graphData({
      commits: [
        commit(0, [], {
          description: '<img src=x onerror="window.pwned=1"></script><b>bold</b>',
          author: "<i>Eve</i>",
          topic: '"><svg>',
        }),
      ],
      current: { rev: 0, node: "x", topic: "" },
    });
    const view = render(data);
    assert.equal(view.$(".row .description").textContent, '<img src=x onerror="window.pwned=1"></script><b>bold</b>');
    assert.equal(view.$(".row .author").textContent, "<i>Eve</i>");
    assert.equal(view.$$("#rows img, #rows b, #rows i, #rows svg").length, 0);
    assert.equal(view.window.pwned, undefined);
    assert.ok(view.$$("#topic option").some((option) => option.value === '"><svg>'));
  });

  test("shows a message when nothing matches", () => {
    const view = render();
    view.setValue("#search", "no such text", "input");
    assert.equal(view.$(".empty").textContent, "No matching changesets.");
    assert.equal(view.$("#summary").textContent, "0 changesets");
  });
});

describe("filters", () => {
  test("lists topics and branches with counts", () => {
    const view = render();
    const options = view.$$("#topic option").map((option) => [option.value, option.textContent]);
    assert.deepEqual(options, [
      ["", "All topics"],
      ["default", "default (3)"],
      ["feature", "feature (2)"],
    ]);
  });

  test("filters by topic", () => {
    const view = render();
    view.setValue("#topic", "feature", "change");
    assert.deepEqual(view.rowTexts(), ["feature part 2", "feature part 1"]);
  });

  test("searches messages, authors and hashes case-insensitively", () => {
    const view = render();
    view.setValue("#search", "GRACE", "input");
    assert.deepEqual(view.rowTexts(), ["feature part 1"]);
    view.setValue("#search", "00030003", "input");
    assert.deepEqual(view.rowTexts(), ["mainline work"]);
    view.setValue("#search", "  body that  ", "input");
    assert.deepEqual(view.rowTexts(), ["mainline work"]);
  });
});

describe("graph layout", () => {
  test("keeps the default mainline in the first lane and topics beside it", () => {
    const view = render();
    // Dots are drawn in row order: 4, 3, 2, 1, 0.
    assert.deepEqual(view.dots(), [64, 24, 64, 24, 24]);
  });

  test("uses the lane width setting", () => {
    const view = render(graphData({ laneWidth: 100 }));
    assert.deepEqual(view.dots(), [124, 24, 124, 24, 24]);
  });

  test("starts topic-only views in the first lane", () => {
    const view = render();
    view.setValue("#topic", "feature", "change");
    assert.deepEqual(view.dots(), [24, 24]);
  });

  test("draws one edge per parent link, merges included", () => {
    const commits = [commit(3, [1, 2]), commit(2, [0], { topic: "t" }), commit(1, [0]), commit(0, [])];
    const view = render(graphData({ commits, current: { rev: 3, node: "x", topic: "" } }));
    assert.equal(view.$$("#edges path").length, 4);
    assert.deepEqual(view.dots(), [24, 64, 24, 24]);
  });

  test("keeps default in the first lane when a merge's first parent is a topic", () => {
    const commits = [commit(3, [2, 1]), commit(2, [0], { topic: "t" }), commit(1, [0]), commit(0, [])];
    const view = render(graphData({ commits, current: { rev: 3, node: "x", topic: "" } }));
    assert.deepEqual(view.dots(), [24, 64, 24, 24]);
  });

  test("renders an empty repository", () => {
    const view = render(graphData({ commits: [], current: { rev: -1, node: "0".repeat(40), topic: "" } }));
    assert.equal(view.$(".empty").textContent, "No matching changesets.");
    assert.equal(view.$("#scroll").scrollTop, 0);
  });

  test("draws dashed stubs to parents hidden by a filter", () => {
    const view = render();
    view.setValue("#topic", "feature", "change");
    const stubs = view.$$("#edges path").filter((path) => path.getAttribute("stroke-dasharray"));
    assert.equal(stubs.length, 1);
  });

  test("draws edges to parents that are not loaded down to the bottom", () => {
    const commits = [commit(9, [8]), commit(8, [5])];
    const view = render(graphData({ commits, current: { rev: 9, node: "x", topic: "" }, hasMore: true }));
    const paths = view.$$("#edges path").map((path) => path.getAttribute("d"));
    assert.equal(paths.length, 2);
    // Two rows of 62px: the offscreen edge ends at the third row's centre.
    assert.ok(paths.some((d) => d.endsWith(" 155")), paths.join("\n"));
  });
});

describe("inline details", () => {
  test("opens below the clicked row and requests its files", () => {
    const view = render();
    view.click(view.$$(".row")[2]);
    const panel = view.$(".inline-details");
    assert.ok(panel);
    assert.equal(panel.previousElementSibling.querySelector(".description").textContent, "feature part 1");
    assert.ok(panel.previousElementSibling.classList.contains("expanded"));
    assert.match(panel.querySelector(".hash").textContent, /^2:/);
    assert.equal(panel.querySelector(".files").textContent, "Loading…");
    assert.deepEqual(view.posted.at(-1), { type: "files", rev: 2 });
  });

  test("renders changed files and opens diffs against the first parent", () => {
    const view = render();
    view.click(view.$$(".row")[2]);
    view.receive({
      type: "files",
      rev: 2,
      files: [
        { status: "M", path: "src/a.js", added: 3, deleted: 1, binary: false },
        { status: "A", path: "logo.png", added: 0, deleted: 0, binary: true },
      ],
    });
    const files = view.$$(".inline-details .file");
    assert.equal(files.length, 2);
    assert.equal(files[0].querySelector(".file-path").textContent, "src/a.js");
    assert.equal(files[0].querySelector(".stat-added").textContent, "+3");
    assert.equal(files[0].querySelector(".stat-deleted").textContent, "−1");
    assert.equal(files[1].querySelector(".file-stats").textContent, "bin");

    view.click(files[0]);
    assert.deepEqual(view.posted.at(-1), {
      type: "diff",
      rev: 2,
      parent: 1,
      label: "000200020002",
      parentLabel: "000100010001",
      path: "src/a.js",
    });
  });

  test("shows errors and empty file lists", () => {
    const view = render();
    view.click(view.$$(".row")[2]);
    view.receive({ type: "files", rev: 2, files: [], error: "hg failed" });
    assert.equal(view.$(".inline-details .files").textContent, "hg failed");
    view.click(view.$$(".row")[3]);
    view.receive({ type: "files", rev: 1, files: [] });
    assert.equal(view.$(".inline-details .files").textContent, "No file changes.");
  });

  test("reuses files it already received", () => {
    const view = render();
    view.click(view.$$(".row")[2]);
    view.receive({ type: "files", rev: 2, files: [{ status: "M", path: "x" }] });
    view.click(view.$$(".row")[2]);
    view.click(view.$$(".row")[2]);
    assert.equal(view.posted.filter((message) => message.type === "files").length, 1);
    assert.equal(view.$$(".inline-details .file").length, 1);
  });

  test("closes on a second click, the close button or Escape", () => {
    const view = render();
    view.click(view.$$(".row")[1]);
    view.click(view.$$(".row")[1]);
    assert.equal(view.$(".inline-details"), null);

    view.click(view.$$(".row")[1]);
    view.click(view.$(".inline-close"));
    assert.equal(view.$(".inline-details"), null);

    view.click(view.$$(".row")[1]);
    view.key("Escape");
    assert.equal(view.$(".inline-details"), null);
  });

  test("copies the full hash", () => {
    const view = render();
    view.click(view.$$(".row")[0]);
    view.click(view.$(".inline-details .hash"));
    assert.deepEqual(view.posted.at(-1), { type: "copy", value: "0004".repeat(10) });
  });
});

describe("side details", () => {
  test("shows the current changeset first and follows clicks", () => {
    const view = render(graphData({ detailsLocation: "side" }));
    assert.equal(view.$(".inline-details"), null);
    assert.match(view.$("#details .hash").textContent, /^3:/);
    view.click(view.$$(".row")[0]);
    assert.match(view.$("#details .hash").textContent, /^4:/);
    assert.deepEqual(view.posted.at(-1), { type: "files", rev: 4 });
  });
});

describe("load more", () => {
  const button = (view) => view.$(".load-more button");

  test("is offered only when there are more changesets", () => {
    assert.equal(button(render()), null);
    assert.ok(button(render(graphData({ hasMore: true }))));
  });

  test("is hidden for a loaded topic without older changesets", () => {
    const view = render(graphData({ hasMore: true, olderTopics: ["other"] }));
    view.setValue("#topic", "feature", "change");
    assert.equal(button(view), null);
    view.setValue("#topic", "default", "change");
    assert.ok(button(view), "branches are not covered by olderTopics");
  });

  test("is shown for a topic with older changesets or when topics are unknown", () => {
    let view = render(graphData({ hasMore: true, olderTopics: ["feature"] }));
    view.setValue("#topic", "feature", "change");
    assert.ok(button(view));

    view = render(graphData({ hasMore: true, olderTopics: null }));
    view.setValue("#topic", "feature", "change");
    assert.ok(button(view));
  });

  test("asks for more changesets with the current view state", () => {
    const view = render(graphData({ hasMore: true }));
    view.setValue("#search", "feature", "input");
    view.click(button(view));
    assert.equal(button(view).disabled, true);
    assert.deepEqual(view.posted.at(-1), {
      type: "loadMore",
      state: { topic: "", search: "feature", selectedRev: null, scrollTop: view.$("#scroll").scrollTop },
    });
  });
});

describe("view state", () => {
  test("opens scrolled to the current changeset", () => {
    // jsdom has no layout, so the viewport is 0px high and the current row
    // (the second, 62px down) is centred at 62 + 62 / 2.
    assert.equal(render().$("#scroll").scrollTop, 93);
    const atTop = graphData({ current: { rev: 4, node: "x", topic: "feature" } });
    assert.equal(render(atTop).$("#scroll").scrollTop, 0);
  });

  test("restores the saved scroll position instead", () => {
    const view = render(graphData(), { topic: "", search: "", selectedRev: null, scrollTop: 40 });
    assert.equal(view.$("#scroll").scrollTop, 40);
  });

  test("restores the topic, search and open details", () => {
    const view = render(graphData(), { topic: "feature", search: "part 1", selectedRev: 2, scrollTop: 0 });
    assert.equal(view.$("#topic").value, "feature");
    assert.equal(view.$("#search").value, "part 1");
    assert.deepEqual(view.rowTexts(), ["feature part 1"]);
    assert.ok(view.$(".inline-details"));
  });

  test("ignores a saved topic that no longer exists", () => {
    const view = render(graphData(), { topic: "gone", search: "", selectedRev: null, scrollTop: 0 });
    assert.equal(view.$("#topic").value, "");
    assert.equal(view.rowTexts().length, 5);
  });

  test("sends the view state on refresh", () => {
    const view = render();
    view.setValue("#topic", "feature", "change");
    view.click(view.$("#refresh"));
    assert.deepEqual(view.posted.at(-1), {
      type: "refresh",
      state: { topic: "feature", search: "", selectedRev: null, scrollTop: view.$("#scroll").scrollTop },
    });
  });
});

describe("html helpers", () => {
  test("escapeHtml escapes markup and quotes", () => {
    assert.equal(escapeHtml(`<a href="x">&</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });

  test("errorHtml shows the escaped message", () => {
    const { document } = new JSDOM(errorHtml("bad <thing>")).window;
    assert.equal(document.querySelector("p").textContent, "bad <thing>");
  });

  test("graphHtml uses a fresh script nonce matching the CSP", () => {
    const html = graphHtml(graphData());
    const nonce = html.match(/script-src 'nonce-([A-Za-z0-9]{32})'/)[1];
    assert.ok(html.includes(`<script nonce="${nonce}">`));
    assert.notEqual(nonce, graphHtml(graphData()).match(/'nonce-([A-Za-z0-9]{32})'/)[1]);
  });
});
