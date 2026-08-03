import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  net,
  protocol,
  shell,
} from "electron";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const development = !app.isPackaged;
const executableSuffix = process.platform === "win32" ? ".exe" : "";
let mainWindow = null;
let backend = null;
let backendLines = null;
let backendError = "";
let nextRequestId = 1;
let guardReady = false;
let allowExit = false;
const pending = new Map();

const legacyDataRoot =
  process.platform === "linux"
    ? path.join(app.getPath("home"), ".local", "share")
    : app.getPath("appData");
app.setPath("userData", path.join(legacyDataRoot, "com.tain.researchwriter"));

protocol.registerSchemesAsPrivileged([
  {
    scheme: "rw",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      codeCache: true,
    },
  },
]);

function registerApplicationProtocol() {
  const buildRoot = path.join(root, "build");
  protocol.handle("rw", (request) => {
    const url = new URL(request.url);
    if (url.host !== "app") return new Response("Not found", { status: 404 });
    const relativeUrl = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const requested = path.resolve(buildRoot, relativeUrl || "index.html");
    const relativePath = path.relative(buildRoot, requested);
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      return new Response("Invalid path", { status: 400 });
    }
    return net.fetch(pathToFileURL(requested).toString());
  });
}

function backendPath() {
  if (process.env.RESEARCH_WRITER_BACKEND) return process.env.RESEARCH_WRITER_BACKEND;
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "backend",
      `research-writer-backend${executableSuffix}`,
    );
  }
  const profile = process.env.RESEARCH_WRITER_BACKEND_PROFILE ?? "debug";
  return path.join(
    root,
    "src-tauri",
    "target",
    profile,
    `research-writer-backend${executableSuffix}`,
  );
}

function writeBackend(message) {
  if (!backend?.stdin.writable) {
    throw new Error(backendError || "Research Writer 백엔드가 실행되지 않았습니다.");
  }
  backend.stdin.write(`${JSON.stringify(message)}\n`);
}

function startBackend() {
  const executable = backendPath();
  if (!existsSync(executable)) {
    backendError = `백엔드 실행 파일을 찾을 수 없습니다: ${executable}`;
    return;
  }
  const startupDocument = process.argv
    .slice(1)
    .find((entry) => /\.(?:md|markdown)$/i.test(entry));
  backend = spawn(executable, startupDocument ? [startupDocument] : [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: {
      ...process.env,
      RESEARCH_WRITER_DATA_DIR: app.getPath("userData"),
    },
  });
  backendLines = createInterface({ input: backend.stdout });
  backendLines.on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.event === "string") {
      mainWindow?.webContents.send(`backend:event:${message.event}`, message.payload);
      return;
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (typeof message.error === "string") request.reject(new Error(message.error));
    else request.resolve(message.result);
  });
  backend.stderr.setEncoding("utf8");
  backend.stderr.on("data", (chunk) => {
    backendError = String(chunk).trim() || backendError;
    if (development) process.stderr.write(chunk);
  });
  backend.on("exit", (code) => {
    backend = null;
    const reason = backendError || `백엔드가 종료되었습니다 (${code ?? "unknown"}).`;
    for (const request of pending.values()) request.reject(new Error(reason));
    pending.clear();
  });
}

function invokeBackend(command, args = {}) {
  if (command === "get_runtime_platform") {
    const platform =
      process.platform === "darwin"
        ? "macos"
        : process.platform === "win32"
          ? "windows"
          : "linux";
    return Promise.resolve(platform);
  }
  if (command === "register_exit_guard") {
    guardReady = true;
    return Promise.resolve(null);
  }
  if (command === "complete_app_exit") {
    allowExit = true;
    app.quit();
    return Promise.resolve(null);
  }
  const id = nextRequestId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      writeBackend({ id, command, args });
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 920,
    minHeight: 640,
    show: false,
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: "#d8d1c5",
    webPreferences: {
      preload: path.join(root, "electron", "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("resize", () => mainWindow?.webContents.send("window:resized"));
  mainWindow.on("maximize", () => mainWindow?.webContents.send("window:resized"));
  mainWindow.on("unmaximize", () => mainWindow?.webContents.send("window:resized"));
  mainWindow.on("close", (event) => {
    if (!guardReady || allowExit) return;
    event.preventDefault();
    mainWindow?.webContents.send("window:close-requested");
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = development
      ? url.startsWith(process.env.RESEARCH_WRITER_DEV_URL ?? "http://127.0.0.1:1420")
      : url.startsWith("rw://app/");
    if (!allowed) event.preventDefault();
  });
  if (development) {
    void mainWindow.loadURL(
      process.env.RESEARCH_WRITER_DEV_URL ?? "http://127.0.0.1:1420",
    );
  } else {
    void mainWindow.loadURL("rw://app/");
  }
}

ipcMain.handle("backend:invoke", (_event, request) =>
  invokeBackend(request.command, request.args),
);
ipcMain.handle("dialog:open", async (_event, options) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: options.title,
    defaultPath: options.defaultPath,
    properties: [
      options.directory ? "openDirectory" : "openFile",
      ...(options.multiple ? ["multiSelections"] : []),
    ],
    filters: options.filters,
  });
  if (result.canceled) return null;
  return options.multiple ? result.filePaths : (result.filePaths[0] ?? null);
});
ipcMain.handle("dialog:save", async (_event, options) => {
  const result = await dialog.showSaveDialog(mainWindow, options);
  return result.canceled ? null : (result.filePath ?? null);
});
ipcMain.handle("shell:open-external", async (_event, url) => {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("HTTP 또는 HTTPS 주소만 열 수 있습니다.");
  }
  await shell.openExternal(parsed.toString());
});
ipcMain.handle("window:minimize", () => mainWindow?.minimize());
ipcMain.handle("window:toggle-maximize", () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.handle("window:is-maximized", () => mainWindow?.isMaximized() ?? false);
ipcMain.handle("document:export-pdf", async (_event, suggestedName = "원고.pdf") => {
  if (!mainWindow) throw new Error("PDF를 만들 창을 찾을 수 없습니다.");
  const target = await dialog.showSaveDialog(mainWindow, {
    title: "PDF로 내보내기",
    defaultPath: suggestedName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (target.canceled || !target.filePath) return null;
  const pdf = await mainWindow.webContents.printToPDF({
    pageSize: "A4",
    printBackground: true,
    preferCSSPageSize: true,
    margins: { marginType: "none" },
  });
  await mkdir(path.dirname(target.filePath), { recursive: true });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(target.filePath, pdf);
  return target.filePath;
});

app.whenReady().then(() => {
  if (!development) registerApplicationProtocol();
  startBackend();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (event) => {
  if (!guardReady || allowExit) return;
  event.preventDefault();
  mainWindow?.webContents.send("window:close-requested");
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("will-quit", () => {
  backendLines?.close();
  backend?.kill();
});
