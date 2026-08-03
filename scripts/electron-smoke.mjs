import { writeFile } from "node:fs/promises";

const endpoint = process.env.RESEARCH_WRITER_DEBUG_URL ?? "http://127.0.0.1:9222";
const expectedText =
  process.env.RESEARCH_WRITER_SMOKE_EXPECT ?? "Research Writer";
const expectedSelector = process.env.RESEARCH_WRITER_SMOKE_SELECTOR ?? "";
const deadline = Date.now() + 15_000;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function findPage() {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/list`);
      if (response.ok) {
        const pages = await response.json();
        const page = pages.find(
          (entry) => entry.type === "page" && entry.webSocketDebuggerUrl,
        );
        if (page) return page;
      }
    } catch {
      // The debug endpoint appears shortly after the native window starts.
    }
    await delay(200);
  }
  throw new Error("Electron 디버그 페이지가 준비되지 않았습니다.");
}

async function evaluate(page) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Electron 디버그 연결 시간이 초과됐습니다.")),
      5_000,
    );
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Electron 디버그 연결에 실패했습니다."));
      },
      { once: true },
    );
  });

  const id = 1;
  socket.send(
    JSON.stringify({
      id,
      method: "Runtime.evaluate",
      params: {
        expression: `(async () => ({
          title: document.title,
          bridge: Boolean(window.researchWriter),
          platform: await window.researchWriter?.invoke("get_runtime_platform"),
          selectorMatched: ${expectedSelector ? `Boolean(document.querySelector(${JSON.stringify(expectedSelector)}))` : "true"},
          text: document.body.innerText.slice(0, 2_000)
        }))()`,
        awaitPromise: true,
        returnByValue: true,
      },
    }),
  );

  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Electron 화면 응답 시간이 초과됐습니다.")),
      10_000,
    );
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== id) return;
      clearTimeout(timer);
      resolve(message);
    });
  });
  socket.close();

  if (response.result?.exceptionDetails) {
    throw new Error(
      response.result.exceptionDetails.exception?.description ??
        "Electron 화면에서 예외가 발생했습니다.",
    );
  }
  return response.result?.result?.value;
}

async function captureScreenshot(page, destination) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const id = 2;
  socket.send(
    JSON.stringify({
      id,
      method: "Page.captureScreenshot",
      params: { format: "png", fromSurface: true },
    }),
  );
  const response = await new Promise((resolve) => {
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === id) resolve(message);
    });
  });
  socket.close();
  const data = response.result?.data;
  if (!data) throw new Error("Electron 화면 캡처에 실패했습니다.");
  await writeFile(destination, Buffer.from(data, "base64"));
}

const page = await findPage();
let result;
while (Date.now() < deadline) {
  try {
    result = await evaluate(page);
    if (
      Boolean(result?.title) &&
      result?.bridge === true &&
      ["linux", "macos", "windows"].includes(result?.platform) &&
      result?.selectorMatched === true &&
      String(result?.text ?? "").includes(expectedText)
    ) {
      break;
    }
  } catch {
    // Hydration can replace the initial document while the first probe runs.
  }
  await delay(200);
}
if (
  !result?.title ||
  result?.bridge !== true ||
  !["linux", "macos", "windows"].includes(result?.platform) ||
  result?.selectorMatched !== true ||
  !String(result?.text ?? "").includes(expectedText)
) {
  throw new Error(
    `Electron 스모크 테스트 결과가 올바르지 않습니다: ${JSON.stringify(result)}`,
  );
}
if (process.env.RESEARCH_WRITER_SMOKE_SCREENSHOT) {
  await captureScreenshot(page, process.env.RESEARCH_WRITER_SMOKE_SCREENSHOT);
}
process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(0));
