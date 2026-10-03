const { test } = require("node:test");
const assert = require("node:assert/strict");
require("./helpers/vscode");
const { diffStats } = require("../extension")._internal;

function stats(diff) {
  return Object.fromEntries(diffStats(diff));
}

test("counts added and deleted lines per file", () => {
  const diff = [
    "diff --git a/src/a.js b/src/a.js",
    "--- a/src/a.js",
    "+++ b/src/a.js",
    "@@ -1,3 +1,3 @@",
    " keep",
    "-old",
    "+new",
    "+another",
    "diff --git a/b.txt b/b.txt",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/b.txt",
    "@@ -0,0 +1,1 @@",
    "+hello",
  ].join("\n");
  assert.deepEqual(stats(diff), {
    "src/a.js": { added: 2, deleted: 1, binary: false },
    "b.txt": { added: 1, deleted: 0, binary: false },
  });
});

test("does not count the ---/+++ file headers as changes", () => {
  const diff = [
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-one",
    "-two",
  ].join("\n");
  assert.deepEqual(stats(diff), { "gone.txt": { added: 0, deleted: 2, binary: false } });
});

test("counts content lines that look like headers once inside a hunk", () => {
  const diff = [
    "diff --git a/notes.md b/notes.md",
    "--- a/notes.md",
    "+++ b/notes.md",
    "@@ -1,1 +1,1 @@",
    "--- a horizontal rule",
    "+++ added emphasis",
  ].join("\n");
  assert.deepEqual(stats(diff), { "notes.md": { added: 1, deleted: 1, binary: false } });
});

test("keys renames and copies by their new path", () => {
  const diff = [
    "diff --git a/old name.txt b/new name.txt",
    "rename from old name.txt",
    "rename to new name.txt",
    "diff --git a/src.txt b/copy.txt",
    "copy from src.txt",
    "copy to copy.txt",
    "--- a/src.txt",
    "+++ b/copy.txt",
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
  ].join("\n");
  const result = stats(diff);
  assert.deepEqual(result["new name.txt"], { added: 0, deleted: 0, binary: false });
  assert.deepEqual(result["copy.txt"], { added: 1, deleted: 1, binary: false });
});

test("handles paths containing ' b/'", () => {
  const diff = [
    "diff --git a/dir b/file.txt b/dir b/file.txt",
    "--- a/dir b/file.txt",
    "+++ b/dir b/file.txt",
    "@@ -1,1 +1,1 @@",
    "-x",
    "+y",
  ].join("\n");
  assert.deepEqual(stats(diff), { "dir b/file.txt": { added: 1, deleted: 1, binary: false } });
});

test("marks binary files", () => {
  const diff = [
    "diff --git a/image.png b/image.png",
    "new file mode 100644",
    "index 0000000000000000000000000000000000000000..1111111111111111111111111111111111111111",
    "GIT binary patch",
    "literal 4",
    "LcmZQzWMT#Y01f~L",
    "",
  ].join("\n");
  assert.equal(diffStats(diff).get("image.png").binary, true);
});

test("returns an empty map for an empty diff", () => {
  assert.equal(diffStats("").size, 0);
});
