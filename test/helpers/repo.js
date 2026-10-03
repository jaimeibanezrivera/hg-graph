// Builds throwaway Mercurial repositories for the tests.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "hg-graph-test-"));

// Isolate hg from the user's configuration, and enable topics when the
// extension is installed.
const hgrc = path.join(scratch, "hgrc");
fs.writeFileSync(
  hgrc,
  [
    "[ui]",
    "username = Test Author <test@example.com>",
    "[extensions]",
    hasTopicExtension() ? "topic =" : "",
    "",
  ].join("\n"),
);
process.env.HGRCPATH = hgrc;

function hasTopicExtension() {
  try {
    execFileSync("python3", ["-c", "import hgext3rd.topic"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function hasHg() {
  try {
    execFileSync("hg", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

let counter = 0;

function createRepo() {
  const root = path.join(scratch, `repo-${++counter}`);
  execFileSync("hg", ["init", root]);
  let time = 1700000000;
  const repo = {
    root,
    hg: (...args) => execFileSync("hg", args, { cwd: root, encoding: "utf8" }),
    write(file, content) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    },
    commit(message) {
      repo.hg("commit", "-A", "-m", message, "-d", `${time++} 0`);
      return Number(repo.hg("log", "-r", ".", "-T", "{rev}"));
    },
  };
  return repo;
}

function removeScratch() {
  fs.rmSync(scratch, { recursive: true, force: true });
}

module.exports = { createRepo, hasHg, hasTopicExtension, removeScratch, scratch };
