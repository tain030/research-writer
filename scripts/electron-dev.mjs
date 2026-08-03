import electronPath from "electron";
import { spawn, spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const backend = spawnSync(
  "cargo",
  [
    "build",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "--locked",
    "--bin",
    "research-writer-backend",
  ],
  { stdio: "inherit" },
);
if (backend.status !== 0) process.exit(backend.status ?? 1);

const vite = spawn(pnpm, ["exec", "vite", "dev"], { stdio: "inherit" });
let desktop;
let stopping = false;

async function waitForVite() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:1420");
      if (response.ok) return;
    } catch {
      // Vite is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Vite 개발 서버가 30초 안에 시작되지 않았습니다.");
}

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  desktop?.kill();
  vite.kill();
  process.exitCode = code;
}

process.on("SIGINT", () => stop(130));
process.on("SIGTERM", () => stop(143));
vite.on("exit", (code) => stop(code ?? 1));

try {
  await waitForVite();
  desktop = spawn(electronPath, ["."], {
    stdio: "inherit",
    env: {
      ...process.env,
      RESEARCH_WRITER_DEV_URL: "http://127.0.0.1:1420",
    },
  });
  desktop.on("exit", (code) => stop(code ?? 0));
} catch (error) {
  console.error(error);
  stop(1);
}
