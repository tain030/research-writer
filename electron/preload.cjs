const { contextBridge, ipcRenderer, webUtils } = require("electron");

const subscriptions = new Map();
let nextSubscriptionId = 1;

function registerSubscription(cleanup) {
  const id = nextSubscriptionId++;
  subscriptions.set(id, cleanup);
  return id;
}

function subscribe(channel, listener) {
  const wrapped = (_event, payload) => listener(payload);
  ipcRenderer.on(channel, wrapped);
  return registerSubscription(() => ipcRenderer.removeListener(channel, wrapped));
}

function unsubscribe(id) {
  const cleanup = subscriptions.get(id);
  if (!cleanup) return;
  cleanup();
  subscriptions.delete(id);
}

contextBridge.exposeInMainWorld("researchWriter", {
  invoke: (command, args = {}) =>
    ipcRenderer.invoke("backend:invoke", { command, args }),
  listen: (event, listener) => subscribe(`backend:event:${event}`, listener),
  unsubscribe,
  openDialog: (options) => ipcRenderer.invoke("dialog:open", options),
  saveDialog: (options) => ipcRenderer.invoke("dialog:save", options),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  exportPdf: (suggestedName) =>
    ipcRenderer.invoke("document:export-pdf", suggestedName),
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    toggleMaximize: () => ipcRenderer.invoke("window:toggle-maximize"),
    isMaximized: () => ipcRenderer.invoke("window:is-maximized"),
    onResized: (listener) => subscribe("window:resized", listener),
    onCloseRequested: (listener) =>
      subscribe("window:close-requested", listener),
  },
  onDragDrop: (listener) => {
    const handler = (event) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      const paths = files
        .map((file) => webUtils.getPathForFile(file))
        .filter(Boolean);
      if (paths.length === 0) return;
      event.preventDefault();
      listener(paths);
    };
    const dragOver = (event) => event.preventDefault();
    window.addEventListener("dragover", dragOver);
    window.addEventListener("drop", handler);
    return registerSubscription(() => {
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("drop", handler);
    });
  },
});
