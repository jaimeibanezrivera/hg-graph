// Runs the extension's Mercurial queries against real repositories.
const { test, describe, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { state, reset } = require("./helpers/vscode");
const { createRepo, hasHg, hasTopicExtension, removeScratch } = require("./helpers/repo");
const extension = require("../extension");
const { readGraph, changedFiles, revisionContentProvider } = extension._internal;

const skip = hasHg() ? false : "hg is not installed";
const skipTopics = skip || (hasTopicExtension() ? false : "the topic extension is not installed");

after(removeScratch);

async function waitFor(condition, timeout = 5000) {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeout) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
beforeEach(reset);

describe("readGraph", { skip }, () => {
  let repo;
  before(() => {
    repo = createRepo();
    repo.write("a.txt", "one\n");
    repo.commit("initial");
    repo.write("a.txt", "one\ntwo\n");
    repo.commit("Add two\n\nA longer explanation\nover two lines.");
    repo.hg("branch", "stable");
    repo.write("s.txt", "s\n");
    repo.commit("stable work");
    repo.hg("update", "default");
    repo.write("a.txt", "one\ntwo\nthree\n");
    repo.commit("Add three");
    repo.hg("merge", "stable");
    repo.commit("merge stable");
    repo.hg("update", "1");
  });

  test("returns changesets newest first with their fields", async () => {
    const data = await readGraph(repo.root);
    assert.equal(data.root, repo.root);
    assert.deepEqual(data.commits.map((commit) => commit.rev), [4, 3, 2, 1, 0]);
    const [merge, , stable, second, initial] = data.commits;
    assert.deepEqual(merge.parents, [3, 2]);
    assert.deepEqual(initial.parents, []);
    assert.equal(stable.branch, "stable");
    assert.equal(second.branch, "default");
    assert.equal(second.description, "Add two\n\nA longer explanation\nover two lines.");
    assert.equal(second.author, "Test Author");
    assert.equal(second.phase, "draft");
    assert.match(second.date, /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d{4}$/);
    assert.equal(second.node.length, 40);
    assert.equal(second.shortNode, second.node.slice(0, 12));
    assert.equal(second.topic, "");
  });

  test("reports the working directory parent as the current changeset", async () => {
    const data = await readGraph(repo.root);
    assert.equal(data.current.rev, 1);
    assert.equal(data.current.node, data.commits.find((commit) => commit.rev === 1).node);
  });

  test("uses the default settings", async () => {
    const data = await readGraph(repo.root);
    assert.equal(data.pageSize, 500);
    assert.equal(data.laneWidth, 40);
    assert.equal(data.detailsLocation, "inline");
    assert.equal(data.hasMore, false);
    assert.deepEqual(data.olderTopics, []);
  });

  test("pages by maxCommits", async () => {
    state.settings["hgGraph.maxCommits"] = 2;
    const first = await readGraph(repo.root);
    assert.deepEqual(first.commits.map((commit) => commit.rev), [4, 3]);
    assert.equal(first.hasMore, true);

    const second = await readGraph(repo.root, 1);
    assert.deepEqual(second.commits.map((commit) => commit.rev), [4, 3, 2, 1]);
    assert.equal(second.hasMore, true);

    const all = await readGraph(repo.root, 2);
    assert.equal(all.commits.length, 5);
    assert.equal(all.hasMore, false);
  });

  test("reads the old mercurialTopicMap settings when hgGraph ones are unset", async () => {
    state.settings["mercurialTopicMap.laneWidth"] = 25;
    state.settings["mercurialTopicMap.detailsLocation"] = "side";
    state.settings["hgGraph.detailsLocation"] = "inline";
    const data = await readGraph(repo.root);
    assert.equal(data.laneWidth, 25);
    assert.equal(data.detailsLocation, "inline");
  });
});

describe("readGraph with topics", { skip: skipTopics }, () => {
  let repo;
  before(() => {
    repo = createRepo();
    repo.write("a.txt", "a\n");
    repo.commit("base");
    repo.hg("topic", "old-feature");
    repo.write("old.txt", "old\n");
    repo.commit("old feature");
    repo.hg("update", "default");
    for (let index = 0; index < 4; index++) {
      repo.write("a.txt", `a${index}\n`);
      repo.commit(`mainline ${index}`);
    }
    repo.hg("topic", "new-feature");
    repo.write("new.txt", "new\n");
    repo.commit("new feature");
  });

  test("reads topics for each changeset and the current one", async () => {
    const data = await readGraph(repo.root);
    const byRev = new Map(data.commits.map((commit) => [commit.rev, commit]));
    assert.equal(byRev.get(1).topic, "old-feature");
    assert.equal(byRev.get(2).topic, "");
    assert.equal(byRev.get(6).topic, "new-feature");
    assert.equal(data.current.topic, "new-feature");
  });

  test("lists topics that only have changesets older than the loaded page", async () => {
    state.settings["hgGraph.maxCommits"] = 3;
    const data = await readGraph(repo.root);
    assert.equal(data.hasMore, true);
    assert.deepEqual(data.olderTopics, ["old-feature"]);

    const more = await readGraph(repo.root, 1);
    assert.equal(more.hasMore, true);
    assert.deepEqual(more.olderTopics, []);
  });
});

describe("changedFiles", { skip }, () => {
  let repo;
  let revs;
  before(() => {
    repo = createRepo();
    repo.write("keep.txt", "1\n2\n3\n");
    repo.write("old.txt", "rename me\n");
    repo.write("remove.txt", "x\ny\n");
    const initial = repo.commit("initial");
    repo.write("keep.txt", "1\nTWO\n3\n4\n");
    repo.write("dir with space/new file.txt", "hi\n");
    repo.write("image.bin", Buffer.from([0, 1, 2, 0, 255]));
    repo.hg("remove", "remove.txt");
    repo.hg("mv", "old.txt", "renamed.txt");
    const changes = repo.commit("changes");
    revs = { initial, changes };
  });

  test("lists files with status and line counts", async () => {
    const files = await changedFiles(repo.root, revs.changes);
    const byPath = Object.fromEntries(files.map((file) => [file.path, file]));
    assert.deepEqual(Object.keys(byPath).sort(), [
      "dir with space/new file.txt",
      "image.bin",
      "keep.txt",
      "old.txt",
      "remove.txt",
      "renamed.txt",
    ]);
    assert.deepEqual(byPath["keep.txt"], { status: "M", path: "keep.txt", added: 2, deleted: 1, binary: false });
    assert.deepEqual(byPath["dir with space/new file.txt"], {
      status: "A",
      path: "dir with space/new file.txt",
      added: 1,
      deleted: 0,
      binary: false,
    });
    assert.equal(byPath["remove.txt"].status, "R");
    assert.equal(byPath["remove.txt"].deleted, 2);
    assert.equal(byPath["renamed.txt"].status, "A");
    assert.equal(byPath["old.txt"].status, "R");
    assert.equal(byPath["image.bin"].binary, true);
  });

  test("lists added files for the root changeset", async () => {
    const files = await changedFiles(repo.root, revs.initial);
    assert.ok(files.every((file) => file.status === "A"));
    assert.equal(files.find((file) => file.path === "keep.txt").added, 3);
  });

  test("rejects for an unknown revision", async () => {
    await assert.rejects(changedFiles(repo.root, 999));
  });
});

describe("revisionContentProvider", { skip }, () => {
  let repo;
  before(() => {
    repo = createRepo();
    repo.write("file.txt", "first\n");
    repo.commit("first");
    repo.write("file.txt", "second\n");
    repo.write("[odd] *name*.txt", "glob characters\n");
    repo.commit("second");
  });

  const uri = (rev, file) => ({ path: `/${file}`, query: JSON.stringify({ root: repo.root, rev }) });

  test("returns the file content at a revision", async () => {
    assert.equal(await revisionContentProvider.provideTextDocumentContent(uri(0, "file.txt")), "first\n");
    assert.equal(await revisionContentProvider.provideTextDocumentContent(uri(1, "file.txt")), "second\n");
  });

  test("treats file names literally", async () => {
    assert.equal(
      await revisionContentProvider.provideTextDocumentContent(uri(1, "[odd] *name*.txt")),
      "glob characters\n",
    );
  });

  test("returns empty content for a missing file or no revision", async () => {
    assert.equal(await revisionContentProvider.provideTextDocumentContent(uri(0, "[odd] *name*.txt")), "");
    assert.equal(await revisionContentProvider.provideTextDocumentContent(uri(null, "file.txt")), "");
  });
});

describe("activate", { skip }, () => {
  test("registers the open command and shows the status bar item in a repository", async () => {
    const repo = createRepo();
    state.workspaceFolders = [repo.root];
    const context = { subscriptions: [] };
    extension.activate(context);
    assert.ok(state.commands.has("hgGraph.open"));
    const [item] = state.statusBarItems;
    assert.equal(item.command, "hgGraph.open");
    await waitFor(() => item.visible);
  });

  test("hides the status bar item when turned off", async () => {
    const repo = createRepo();
    state.workspaceFolders = [repo.root];
    extension.activate({ subscriptions: [] });
    const [item] = state.statusBarItems;
    await waitFor(() => item.visible);
    state.settings["hgGraph.showStatusBarItem"] = false;
    for (const listener of state.configListeners) {
      listener({ affectsConfiguration: (key) => key === "hgGraph.showStatusBarItem" });
    }
    assert.equal(item.visible, false);
  });

  test("shows an error when opening without a workspace folder", async () => {
    extension.activate({ subscriptions: [] });
    await state.commands.get("hgGraph.open")();
    assert.deepEqual(state.errors, ["Open a folder containing a Mercurial repository first."]);
  });
});
