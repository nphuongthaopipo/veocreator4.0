const { app, BrowserWindow, screen: electronScreen, ipcMain } = require('electron');
const path = require('path');
// Sử dụng puppeteer-extra và plugin stealth
const puppeteer = require('puppeteer-extra'); 
const StealthPlugin = require('puppeteer-extra-plugin-stealth'); 

// Áp dụng plugin stealth
puppeteer.use(StealthPlugin());

// =================================================================
// 1. HÀM XỬ LÝ API (KHÔNG THAY ĐỔI)
// =================================================================
async function handleApiRequest(_event, { url, cookie, options }) {
    try {
        const targetUrl = new URL(url);
        let headers = {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            ...options.headers,
        };

        if (targetUrl.hostname === 'labs.google') {
            headers = { ...headers, 'Accept': '*/*', 'Cookie': cookie.value, 'Origin': 'https://labs.google', 'Referer': 'https://labs.google/', 'X-Same-Domain': '1' };
        } else if (targetUrl.hostname === 'aisandbox-pa.googleapis.com') {
            if (!cookie.bearerToken) throw new Error("Bearer Token is required.");
            headers = { ...headers, 'Accept': 'application/json, text/plain, */*', 'Authorization': `Bearer ${cookie.bearerToken}`, 'Cookie': cookie.value, 'Origin': 'https://labs.google', 'Referer': 'https://labs.google/' };
        }
        
        const body = typeof options.body === 'object' ? JSON.stringify(options.body) : options.body;
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
        throw new Error(error.message || 'An unknown network error occurred.');
    }
}

// =================================================================
// 2. LOGIC TỰ ĐỘNG HÓA TRÌNH DUYỆT (ĐÃ SỬA LỖI)
// =================================================================
ipcMain.on('browser:start-automation', async (event, { prompts }) => {
    const mainWindow = BrowserWindow.fromWebContents(event.sender);
    
    const sendLog = (promptId, message, status, videoUrl = null) => {
        if (mainWindow) {
            mainWindow.webContents.send('browser:log', { promptId, message, status, videoUrl });
        }
        console.log(`[${promptId || 'general'}] ${message}`);
    };

    let browser = null;
    const firstPromptId = prompts[0]?.id || 'automation-task';

    try {
        const userDataDir = path.join(app.getPath('userData'), 'puppeteer_profile');
        sendLog(firstPromptId, `Sử dụng hồ sơ tại: ${userDataDir}`, 'running');

        browser = await puppeteer.launch({
            headless: false,
            defaultViewport: null,
            args: ['--start-maximized'],
            userDataDir: userDataDir,
        });
        
        const page = (await browser.pages())[0];
        
        await page.goto('https://labs.google/fx/vi/tools/flow', { waitUntil: 'networkidle2' });
        
        if (page.url().includes('accounts.google.com')) {
            sendLog(firstPromptId, 'VUI LÒNG ĐĂNG NHẬP. Ứng dụng sẽ chờ...', 'running');
            await page.waitForNavigation({ timeout: 300000, waitUntil: 'networkidle2' });
        }
        sendLog(firstPromptId, 'Đã đăng nhập!', 'running');

        if (!page.url().includes('/project/')) {
            sendLog(firstPromptId, 'Tự động tạo dự án mới qua API...', 'running');
            const newProject = await page.evaluate(() => {
                return fetch('https://labs.google/fx/api/trpc/project.createProject', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ json: { projectTitle: `Veo Project Auto - ${new Date().toLocaleString()}`, toolName: "PINHOLE" }})
                }).then(res => res.json());
            });
            const projectId = newProject?.result?.data?.json?.result?.projectId;
            if (!projectId) throw new Error('Không thể tạo dự án mới qua API.');
            const newProjectUrl = `https://labs.google/fx/vi/tools/flow/project/${projectId}`;
            sendLog(firstPromptId, `Đã tạo dự án ${projectId}. Đang điều hướng...`, 'running');
            await page.goto(newProjectUrl, { waitUntil: 'networkidle2' });
        }
        
        const promptInputSelector = 'textarea#PINHOLE_TEXT_AREA_ELEMENT_ID';
        await page.waitForSelector(promptInputSelector, { timeout: 60000 });
        sendLog(firstPromptId, 'Đã sẵn sàng để xử lý prompts.', 'running');
        
        for (const prompt of prompts) {
            try {
                const initialVideoCount = await page.evaluate(() => document.querySelectorAll('video[src^="https://storage.googleapis.com"]').length);

                sendLog(prompt.id, 'Bắt đầu xử lý prompt...', 'running');
                await page.type(promptInputSelector, prompt.text, { delay: 20 });
                
                // **SỬA LỖI:** Dùng evaluate để tìm và click chính xác nút Gửi (mũi tên)
                await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    const targetButton = buttons.find(btn => {
                        const icon = btn.querySelector('.google-symbols');
                        return icon && icon.textContent.trim() === 'arrow_forward';
                    });
                    if (targetButton) {
                        (targetButton as HTMLElement).click();
                    } else {
                        throw new Error('Không tìm thấy nút Gửi prompt (biểu tượng mũi tên).');
                    }
                });

                sendLog(prompt.id, 'Đã gửi yêu cầu, đang chờ video được tạo...', 'running');

                await page.waitForFunction(
                    (expectedCount) => document.querySelectorAll('video[src^="https://storage.googleapis.com"]').length > expectedCount,
                    { timeout: 300000 },
                    initialVideoCount
                );
                
                const videoUrl = await page.evaluate(() => {
                    const videoElements = document.querySelectorAll('video[src^="https://storage.googleapis.com"]');
                    const lastVideo = videoElements[videoElements.length - 1] as HTMLVideoElement;
                    return lastVideo ? lastVideo.src : null;
                });

                if (videoUrl) {
                    sendLog(prompt.id, 'Video đã hoàn thành!', 'success', videoUrl);
                } else {
                    sendLog(prompt.id, 'Video đã hoàn thành nhưng không tìm thấy URL!', 'error');
                }

                await page.click(promptInputSelector, { clickCount: 3 });
                await page.keyboard.press('Backspace');
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (promptError) {
                 sendLog(prompt.id, `Lỗi khi xử lý prompt: ${promptError.message}`, 'error');
            }
        }
        
        sendLog(firstPromptId, 'Tất cả các prompt đã được xử lý!', 'success');

    } catch (error) {
        let errorMessage = `Lỗi nghiêm trọng: ${error.message}`;
        if (error.name === 'TimeoutError') errorMessage = 'Lỗi: Hết thời gian chờ.';
        if (prompts && prompts.length > 0) prompts.forEach(p => sendLog(p.id, errorMessage, 'error'));
        else sendLog(null, errorMessage, 'error');
    } finally {
        if (browser) {
            setTimeout(() => browser.close(), 120000); 
        }
    }
});

// =================================================================
// 3. HÀM TẠO CỬA SỔ CHÍNH VÀ VÒNG ĐỜI ỨNG DỤNG (KHÔNG THAY ĐỔI)
// =================================================================
function createWindow() {
  const primaryDisplay = electronScreen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;

  const mainWindow = new BrowserWindow({
    width: width,
    height: height,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    },
  });

  const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL'];
  if (VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(VITE_DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }
}

app.whenReady().then(() => {
    ipcMain.handle('fetch-api', handleApiRequest);
    createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
