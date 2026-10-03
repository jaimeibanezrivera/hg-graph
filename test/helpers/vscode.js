// A minimal stand-in for the "vscode" module, covering the API extension.js
// uses. Tests change `state` to control settings and workspace folders, and
// read it to see what the extension registered.
const Module = require("module");
const path = require("path");

const state = {
  settings: {},
  workspaceFolders: [],
  commands: new Map(),
  executed: [],
  errors: [],
  statusBarItems: [],
  configListeners: [],
  quickPick: undefined,
};

function reset() {
  state.settings = {};
  state.workspaceFolders = [];
  state.commands.clear();
  state.executed = [];
  state.errors = [];
  state.statusBarItems = [];
  state.configListeners = [];
  state.quickPick = undefined;
}

const disposable = { dispose() {} };

const vscode = {
  ViewColumn: { Active: -1 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  Uri: {
    from(components) {
      return { ...components, toString: () => `${components.scheme}:${components.path}?${components.query}` };
    },
  },
  workspace: {
    get workspaceFolders() {
      return state.workspaceFolders.map((fsPath) => ({
        name: path.basename(fsPath),
        uri: { fsPath },
      }));
    },
    getConfiguration(section) {
      const value = (key) => state.settings[`${section}.${key}`];
      return {
        inspect: (key) => ({ globalValue: value(key) }),
        get: (key, fallback) => (value(key) === undefined ? fallback : value(key)),
      };
    },
    registerTextDocumentContentProvider: () => disposable,
    onDidChangeWorkspaceFolders: () => disposable,
    onDidChangeConfiguration(listener) {
      state.configListeners.push(listener);
      return disposable;
    },
  },
  window: {
    createStatusBarItem() {
      const item = { visible: false, show() { this.visible = true; }, hide() { this.visible = false; }, dispose() {} };
      state.statusBarItems.push(item);
      return item;
    },
    showErrorMessage(message) {
      state.errors.push(message);
    },
    showQuickPick: async (items) => (state.quickPick ? state.quickPick(items) : items[0]),
    setStatusBarMessage: () => disposable,
    createWebviewPanel: () => {
      throw new Error("createWebviewPanel is not mocked");
    },
  },
  commands: {
    registerCommand(id, callback) {
      state.commands.set(id, callback);
      return disposable;
    },
    async executeCommand(...args) {
      state.executed.push(args);
    },
  },
  env: { clipboard: { writeText: async () => {} } },
};

const originalLoad = Module._load;
Module._load = function load(request, ...rest) {
  return request === "vscode" ? vscode : originalLoad.call(this, request, ...rest);
};

module.exports = { vscode, state, reset };
