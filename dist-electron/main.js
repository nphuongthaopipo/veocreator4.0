"use strict";
const { app, BrowserWindow, screen: electronScreen, ipcMain } = require("electron");
const path = require("path");
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
async function handleApiRequest(_event, { url, cookie, options }) {
  try {
    const targetUrl = new URL(url);
    let headers = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      ...options.headers
    };
    if (targetUrl.hostname === "labs.google") {
      headers = { ...headers, "Accept": "*/*", "Cookie": cookie.value, "Origin": "https://labs.google", "Referer": "https://labs.google/", "X-Same-Domain": "1" };
    } else if (targetUrl.hostname === "aisandbox-pa.googleapis.com") {
      if (!cookie.bearerToken) throw new Error("Bearer Token is required.");
      headers = { ...headers, "Accept": "application/json, text/plain, */*", "Authorization": `Bearer ${cookie.bearerToken}`, "Cookie": cookie.value, "Origin": "https://labs.google", "Referer": "https://labs.google/" };
    }
    const body = typeof options.body === "object" ? JSON.stringify(options.body) : options.body;
    const response = await fetch(url, { ...options, headers, body });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("API Error Response:", errorText);
      throw new Error(`API request to ${url} failed with status ${response.status}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  } catch (error) {
    console.error(`Failed to fetch ${url}`, error);
    throw new Error(error.message || "An unknown network error occurred.");
  }
}
ipcMain.on("browser:start-automation", async (event, { prompts }) => {
  const mainWindow = BrowserWindow.fromWebContents(event.sender);
  const sendLog = (promptId, message, status, videoUrl = null) => {
    if (mainWindow) {
      mainWindow.webContents.send("browser:log", { promptId, message, status, videoUrl });
    }
    console.log(`[${promptId || "general"}] ${message}`);
  };
  let browser = null;
  const firstPromptId = prompts[0]?.id || "automation-task";
  try {
    const userDataDir = path.join(app.getPath("userData"), "puppeteer_profile");
    sendLog(firstPromptId, `Sử dụng hồ sơ tại: ${userDataDir}`, "running");
    browser = await puppeteer.launch({
      headless: false,
      defaultViewport: null,
      args: ["--start-maximized"],
      userDataDir
    });
    const page = (await browser.pages())[0];
    await page.goto("https://labs.google/fx/vi/tools/flow", { waitUntil: "networkidle2" });
    if (page.url().includes("accounts.google.com")) {
      sendLog(firstPromptId, "VUI LÒNG ĐĂNG NHẬP. Ứng dụng sẽ chờ...", "running");
      await page.waitForNavigation({ timeout: 3e5, waitUntil: "networkidle2" });
    }
    sendLog(firstPromptId, "Đã đăng nhập!", "running");
    let projectId;
    if (!page.url().includes("/project/")) {
      sendLog(firstPromptId, "Tự động tạo dự án mới qua API...", "running");
      const newProject = await page.evaluate(() => {
        return fetch("https://labs.google/fx/api/trpc/project.createProject", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ json: { projectTitle: `Veo Project Auto - ${(/* @__PURE__ */ new Date()).toLocaleString()}`, toolName: "PINHOLE" } })
        }).then((res) => res.json());
      });
      projectId = newProject?.result?.data?.json?.result?.projectId;
      if (!projectId) throw new Error("Không thể tạo dự án mới qua API.");
      const newProjectUrl = `https://labs.google/fx/vi/tools/flow/project/${projectId}`;
      sendLog(firstPromptId, `Đã tạo dự án ${projectId}. Đang điều hướng...`, "running");
      await page.goto(newProjectUrl, { waitUntil: "networkidle2" });
    } else {
      projectId = page.url().split("/project/")[1].split("/")[0];
      sendLog(firstPromptId, `Đang ở trong dự án ${projectId}.`, "running");
    }
    sendLog(firstPromptId, "Đã sẵn sàng để xử lý prompts.", "running");
    const MAX_CONCURRENT = 5;
    const POLL_INTERVAL = 1e4;
    const promptQueue = [...prompts];
    const processingMap = /* @__PURE__ */ new Map();
    const checkStatus = async () => {
      if (processingMap.size === 0) return;
      const operationsToCheck = Array.from(processingMap.values()).map((p) => ({
        operation: { name: p.operationName },
        sceneId: p.sceneId
      }));
      try {
        const statusResponse = await page.evaluate((ops) => {
          return fetch("https://aisandbox-pa.googleapis.com/v1/video:batchCheckAsyncVideoGenerationStatus", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ operations: [ops] })
          }).then((res) => res.json());
        }, operationsToCheck);
        if (!statusResponse || !statusResponse.operations) return;
        for (const operationStatus of statusResponse.operations) {
          const sceneId = operationStatus?.operation?.metadata?.sceneId;
          const promptInProcess = processingMap.get(sceneId);
          if (!promptInProcess) continue;
          if (operationStatus?.status === "MEDIA_GENERATION_STATUS_SUCCESSFUL") {
            const videoUrl = operationStatus?.operation?.metadata?.video?.servingBaseUri;
            sendLog(promptInProcess.id, "Video đã hoàn thành!", "success", videoUrl);
            processingMap.delete(sceneId);
          } else if (operationStatus?.status === "MEDIA_GENERATION_STATUS_FAILED") {
            sendLog(promptInProcess.id, `Lỗi: ${operationStatus?.error?.message || "Không rõ"}`, "error");
            processingMap.delete(sceneId);
          }
        }
      } catch (err) {
        console.error("Lỗi khi kiểm tra trạng thái:", err);
      }
    };
    const poller = setInterval(checkStatus, POLL_INTERVAL);
    while (promptQueue.length > 0 || processingMap.size > 0) {
      if (promptQueue.length > 0 && processingMap.size < MAX_CONCURRENT) {
        const prompt = promptQueue.shift();
        try {
          sendLog(prompt.id, "Gửi yêu cầu tạo video...", "running");
          const responseData = await page.evaluate(async (pId, pText) => {
            const clientSceneId = `client-generated-uuid-${Date.now()}-${Math.random()}`;
            const res = await fetch("https://aisandbox-pa.googleapis.com/v1/video:batchAsyncGenerateVideoText", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                clientContext: { projectId: pId, tool: "PINHOLE" },
                requests: [{
                  aspectRatio: "VIDEO_ASPECT_RATIO_LANDSCAPE",
                  seed: Math.floor(Math.random() * 1e5),
                  textInput: { prompt: pText },
                  videoModelKey: "veo_3_0_t2v_fast",
                  metadata: [{ sceneId: clientSceneId }]
                }]
              })
            });
            return res.json();
          }, projectId, prompt.text);
          const operation = responseData?.operations?.[0];
          const serverSceneId = operation?.sceneId;
          if (!operation || !operation.operation?.name || !serverSceneId) {
            console.error("Phản hồi không hợp lệ từ API:", JSON.stringify(responseData));
            throw new Error("Không nhận được operationName hoặc sceneId từ API.");
          }
          const { name: operationName } = operation.operation;
          sendLog(prompt.id, "Đã gửi yêu cầu, đang chờ xử lý...", "running");
          processingMap.set(serverSceneId, { ...prompt, operationName, sceneId: serverSceneId });
        } catch (promptError) {
          sendLog(prompt.id, `Lỗi khi gửi prompt: ${promptError.message}`, "error");
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 2e3));
    }
    clearInterval(poller);
    sendLog(firstPromptId, "Tất cả các prompt đã được xử lý!", "success");
  } catch (error) {
    let errorMessage = `Lỗi nghiêm trọng: ${error.message}`;
    if (error.name === "TimeoutError") errorMessage = "Lỗi: Hết thời gian chờ.";
    if (prompts && prompts.length > 0) prompts.forEach((p) => sendLog(p.id, errorMessage, "error"));
    else sendLog(null, errorMessage, "error");
  } finally {
    if (browser) {
      setTimeout(() => browser.close(), 12e4);
    }
  }
});
function createWindow() {
  const primaryDisplay = electronScreen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const mainWindow = new BrowserWindow({
    width,
    height,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js")
    }
  });
  const VITE_DEV_SERVER_URL = process.env["VITE_DEV_SERVER_URL"];
  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}
app.whenReady().then(() => {
  ipcMain.handle("fetch-api", handleApiRequest);
  createWindow();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
