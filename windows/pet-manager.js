const { BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SETTINGS_FILE = 'desktop-pet.json';
const VISION_CREDENTIALS_FILE = 'doubao-vision-credentials.json';
const SETTINGS_VERSION = 1;
const ARK_ENDPOINT = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';
const DEFAULT_VISION_MODEL = 'doubao-seed-2-0-lite-260215';
const ACTION_NAMES = ['idle', 'thinking', 'executing', 'success', 'error'];
const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);
const STATUS_TEXT = {
  idle: '准备好了',
  thinking: '正在思考…',
  executing: '正在执行命令…',
  success: '完成啦',
  error: '遇到问题了',
};

const HARNESS_BRIDGE_SCRIPT = fs.readFileSync(path.join(__dirname, 'pet-harness-bridge.js'), 'utf8');

function clamp(value, minimum, maximum) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(maximum, Math.max(minimum, number)) : minimum;
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; }
}

function writeJsonAtomic(filename, value, mode = 0o600) {
  const temporaryPath = `${filename}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.renameSync(temporaryPath, filename);
  try { fs.chmodSync(filename, mode); } catch {}
}

function safeIdentifier(value) {
  const normalized = String(value || '').trim();
  return /^[A-Za-z0-9_-]{1,64}$/.test(normalized) ? normalized : '';
}

function safeImageName(value) {
  const normalized = String(value || '').trim();
  if (!normalized || path.basename(normalized) !== normalized) return '';
  return IMAGE_MIME.has(path.extname(normalized).toLowerCase()) ? normalized : '';
}

function normalizeSettings(value = {}) {
  return {
    version: SETTINGS_VERSION,
    enabled: value.enabled !== false,
    alwaysOnTop: value.alwaysOnTop !== false,
    showStatus: value.showStatus !== false,
    showChatPanel: value.showChatPanel !== false,
    size: Math.round(clamp(value.size ?? 300, 220, 420) / 10) * 10,
    opacity: clamp(value.opacity ?? 1, 0.55, 1),
    characterId: safeIdentifier(value.characterId) || 'default-maid',
    visionModel: String(value.visionModel || DEFAULT_VISION_MODEL).trim().slice(0, 160) || DEFAULT_VISION_MODEL,
    position: value.position && Number.isInteger(value.position.x) && Number.isInteger(value.position.y)
      ? { x: value.position.x, y: value.position.y }
      : null,
  };
}

function contentToText(content) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.map((item) => typeof item === 'string' ? item : (item?.text || '')).join('\n').trim();
}

function createDesktopPet({ app, mainWindow, onMenuChange = () => {} }) {
  let petWindow = null;
  let settingsWindow = null;
  let settings = null;
  let status = 'idle';
  let statusText = STATUS_TEXT.idle;
  let statusTimer = null;
  let successTimer = null;
  let moveTimer = null;
  let monitorRunning = false;
  let imageProcessing = false;
  let lastBusy = false;
  let lastSubmitAt = 0;
  let messages = [];
  let messagesSignature = '';
  let destroyed = false;
  const handlers = [];

  const settingsPath = () => path.join(app.getPath('userData'), SETTINGS_FILE);
  const visionCredentialsPath = () => path.join(app.getPath('userData'), VISION_CREDENTIALS_FILE);
  const userPetDirectory = () => path.join(app.getPath('userData'), 'pets');
  const builtinPetDirectory = () => path.join(app.getAppPath(), 'assets', 'pets', 'default-maid');

  function loadSettings() {
    if (!settings) settings = normalizeSettings(readJson(settingsPath()) || {});
    return settings;
  }

  function saveSettings() {
    settings = normalizeSettings(settings);
    writeJsonAtomic(settingsPath(), settings);
  }

  function visionApiKey() {
    const value = readJson(visionCredentialsPath());
    return typeof value?.apiKey === 'string' ? value.apiKey.trim() : '';
  }

  function saveVisionApiKey(value) {
    const key = String(value || '').trim();
    if (!key || key.length < 20 || key.length > 512 || !/^[\x21-\x7E]+$/.test(key)) {
      throw new Error('请输入有效的火山方舟 API Key。');
    }
    writeJsonAtomic(visionCredentialsPath(), { apiKey: key });
  }

  function removeVisionApiKey() {
    try { fs.rmSync(visionCredentialsPath(), { force: true }); } catch {}
  }

  function parsePet(directory, builtin = false) {
    const manifest = readJson(path.join(directory, 'pet.json'));
    const id = safeIdentifier(manifest?.id);
    const name = String(manifest?.name || '').trim().slice(0, 80);
    const idleName = safeImageName(manifest?.actions?.idle);
    if (!id || !name || !idleName) return null;
    const idlePath = path.join(directory, idleName);
    if (!fs.existsSync(idlePath)) return null;
    const actions = {};
    for (const action of ACTION_NAMES) {
      const filename = safeImageName(manifest?.actions?.[action]);
      const candidate = filename ? path.join(directory, filename) : idlePath;
      const resolved = fs.existsSync(candidate) ? candidate : idlePath;
      actions[action] = pathToFileURL(resolved).toString();
    }
    return {
      id,
      name,
      author: String(manifest?.author || '').trim().slice(0, 80),
      builtin,
      actions,
    };
  }

  function characters() {
    fs.mkdirSync(userPetDirectory(), { recursive: true });
    const result = [];
    const builtin = parsePet(builtinPetDirectory(), true);
    if (builtin) result.push(builtin);
    let entries = [];
    try { entries = fs.readdirSync(userPetDirectory(), { withFileTypes: true }); } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const pet = parsePet(path.join(userPetDirectory(), entry.name));
      if (pet && !result.some((item) => item.id === pet.id)) result.push(pet);
    }
    return result;
  }

  function activeCharacter() {
    const list = characters();
    return list.find((item) => item.id === loadSettings().characterId) || list[0] || null;
  }

  function publicState() {
    const selected = activeCharacter();
    return {
      status,
      statusText,
      showStatus: loadSettings().showStatus,
      showChatPanel: loadSettings().showChatPanel,
      visionReady: Boolean(visionApiKey()),
      messages,
      characterId: selected?.id || '',
      actions: selected?.actions || {},
    };
  }

  function settingsPayload() {
    return {
      settings: { ...loadSettings() },
      hasVisionApiKey: Boolean(visionApiKey()),
      characters: characters(),
      arkEndpoint: ARK_ENDPOINT,
    };
  }

  function broadcastState() {
    if (petWindow && !petWindow.isDestroyed()) petWindow.webContents.send('desktop-pet:state', publicState());
  }

  function setStatus(next, detail = '') {
    if (!ACTION_NAMES.includes(next)) next = 'idle';
    status = next;
    statusText = String(detail || STATUS_TEXT[next]).slice(0, 100);
    broadcastState();
  }

  function scheduleIdle(delay = 2400) {
    clearTimeout(successTimer);
    successTimer = setTimeout(() => setStatus('idle'), delay);
  }

  function defaultBounds() {
    const current = loadSettings();
    const width = current.size;
    const workArea = screen.getPrimaryDisplay().workArea;
    const desiredHeight = Math.round(current.size * (current.showChatPanel ? 1.9 : 1.28));
    const height = Math.min(desiredHeight, workArea.height - 20);
    const saved = current.position;
    if (saved && saved.x >= workArea.x - width + 80 && saved.x <= workArea.x + workArea.width - 80
      && saved.y >= workArea.y && saved.y <= workArea.y + workArea.height - 80) {
      return {
        x: Math.round(clamp(saved.x, workArea.x - width + 80, workArea.x + workArea.width - 80)),
        y: Math.round(clamp(saved.y, workArea.y, workArea.y + workArea.height - height)),
        width,
        height,
      };
    }
    return { x: workArea.x + workArea.width - width - 24, y: workArea.y + workArea.height - height - 18, width, height };
  }

  function applyWindowSettings() {
    if (!petWindow || petWindow.isDestroyed()) return;
    const current = loadSettings();
    const bounds = defaultBounds();
    petWindow.setBounds(bounds, true);
    petWindow.setAlwaysOnTop(current.alwaysOnTop, 'floating');
    petWindow.setOpacity(current.opacity);
    if (current.enabled) petWindow.showInactive(); else petWindow.hide();
    broadcastState();
    onMenuChange();
  }

  function createPetWindow() {
    if (petWindow && !petWindow.isDestroyed()) return petWindow;
    const bounds = defaultBounds();
    petWindow = new BrowserWindow({
      ...bounds,
      title: 'DeepSeek Harness 桌宠',
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      alwaysOnTop: loadSettings().alwaysOnTop,
      skipTaskbar: true,
      hasShadow: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      show: false,
      icon: path.join(app.getAppPath(), 'assets', 'DeepSeek-Harness-icon.ico'),
      webPreferences: {
        preload: path.join(app.getAppPath(), 'pet-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    petWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    petWindow.loadFile(path.join(app.getAppPath(), 'pet-window.html'));
    petWindow.webContents.on('did-finish-load', broadcastState);
    petWindow.on('move', () => {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(() => {
        if (!petWindow || petWindow.isDestroyed()) return;
        const [x, y] = petWindow.getPosition();
        settings = { ...loadSettings(), position: { x, y } };
        saveSettings();
      }, 350);
    });
    petWindow.on('closed', () => { petWindow = null; onMenuChange(); });
    petWindow.once('ready-to-show', () => {
      if (loadSettings().enabled) petWindow.showInactive();
      applyWindowSettings();
    });
    return petWindow;
  }

  function showPet() {
    settings = { ...loadSettings(), enabled: true };
    saveSettings();
    createPetWindow();
    applyWindowSettings();
  }

  function hidePet() {
    settings = { ...loadSettings(), enabled: false };
    saveSettings();
    if (petWindow && !petWindow.isDestroyed()) petWindow.hide();
    onMenuChange();
  }

  function openSettings() {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.show();
      settingsWindow.focus();
      return;
    }
    settingsWindow = new BrowserWindow({
      title: '桌宠设置',
      width: 660,
      height: 760,
      minWidth: 560,
      minHeight: 640,
      parent: mainWindow,
      modal: false,
      backgroundColor: '#f8fafc',
      autoHideMenuBar: true,
      icon: path.join(app.getAppPath(), 'assets', 'DeepSeek-Harness-icon.ico'),
      webPreferences: {
        preload: path.join(app.getAppPath(), 'pet-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    settingsWindow.setMenu(null);
    settingsWindow.loadFile(path.join(app.getAppPath(), 'pet-settings.html'));
    settingsWindow.on('closed', () => { settingsWindow = null; });
  }

  async function installHarnessBridge() {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return false;
    try { return Boolean(await mainWindow.webContents.executeJavaScript(HARNESS_BRIDGE_SCRIPT, true)); } catch { return false; }
  }

  async function sendMessage(message, options = {}) {
    const text = String(message || '').trim();
    if (!text) throw new Error('请输入要发送的内容。');
    if (text.length > 12000) throw new Error('消息过长，请控制在 12000 个字符以内。');
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('当前聊天窗口不可用。');
    await installHarnessBridge();
    clearTimeout(successTimer);
    lastSubmitAt = Date.now();
    setStatus('thinking');
    const result = await mainWindow.webContents.executeJavaScript(
      `window.__dshDesktopPetSend(${JSON.stringify(text)}, ${JSON.stringify(options)})`, true);
    if (!result?.ok) {
      setStatus('error', result?.error || '发送失败');
      scheduleIdle(3500);
      throw new Error(result?.error || '无法发送到当前聊天。');
    }
    return { ok: true };
  }

  function validateImageDataUrl(value) {
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''));
    if (!match) throw new Error('图片格式无效，仅支持 PNG、JPG、WebP 和 GIF。');
    const bytes = Math.floor(match[2].length * 3 / 4) - (match[2].endsWith('==') ? 2 : match[2].endsWith('=') ? 1 : 0);
    if (bytes > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB。');
    return String(value);
  }

  async function analyzeImageData(dataUrl, question) {
    const apiKey = visionApiKey();
    if (!apiKey) {
      openSettings();
      throw new Error('请先在桌宠设置中填写火山方舟 API Key。');
    }
    const validatedDataUrl = validateImageDataUrl(dataUrl);
    const userQuestion = String(question || '').trim().slice(0, 2000);
    const prompt = userQuestion
      ? `请用中文准确、详细地识别这张图片，并重点回答用户的问题：${userQuestion}。如果是报错截图，请提取关键报错；如果是界面图，请描述布局、文字和可见状态。不要猜测看不清的内容。`
      : '请用中文准确、详细地识别这张图片。如果是报错截图，请提取关键报错；如果是界面图，请描述布局、文字和可见状态。不要猜测看不清的内容。';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);
    let response;
    try {
      response = await fetch(ARK_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
        body: JSON.stringify({
          model: loadSettings().visionModel,
          messages: [{ role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: validatedDataUrl } },
          ] }],
          temperature: 0.1,
          max_tokens: 1400,
        }),
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error('豆包识图超时，请检查网络后重试。');
      throw new Error(`豆包识图连接失败：${error.message}`);
    } finally {
      clearTimeout(timeout);
    }
    let body = null;
    try { body = await response.json(); } catch {}
    if (!response.ok) {
      const detail = String(body?.error?.message || body?.message || `HTTP ${response.status}`).slice(0, 300);
      throw new Error(`豆包识图失败：${detail}`);
    }
    const description = contentToText(body?.choices?.[0]?.message?.content);
    if (!description) throw new Error('豆包没有返回可用的图片描述。');
    return { description, userQuestion };
  }

  async function processImageData(dataUrl, question) {
    if (imageProcessing) throw new Error('上一张图片仍在识别，请稍候。');
    imageProcessing = true;
    clearTimeout(successTimer);
    setStatus('thinking', '正在识别图片…');
    try {
      const result = await analyzeImageData(dataUrl, question);
      const combined = [
        '用户附加了一张图片。以下是视觉模型返回的文字描述，请只把它作为图片上下文继续完成用户请求：',
        '',
        result.description,
        '',
        `用户问题：${result.userQuestion || '请根据识图结果解释图片内容，并给出有用的下一步。'}`,
      ].join('\n');
      await sendMessage(combined, { requireNoImage: true });
      return { ok: true };
    } catch (error) {
      setStatus('error', error.message);
      scheduleIdle(4500);
      if (!visionApiKey()) openSettings();
      throw error;
    } finally {
      imageProcessing = false;
    }
  }

  async function chooseImage(question) {
    if (!visionApiKey()) {
      setStatus('error', '请先配置图片识别');
      scheduleIdle(4500);
      openSettings();
      throw new Error('请先在桌宠设置中填写火山方舟 API Key。');
    }
    const selection = await dialog.showOpenDialog(mainWindow, {
      title: '选择要识别的图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (selection.canceled || !selection.filePaths[0]) return { canceled: true };
    try {
      const filename = selection.filePaths[0];
      const extension = path.extname(filename).toLowerCase();
      const mime = IMAGE_MIME.get(extension);
      if (!mime) throw new Error('仅支持 PNG、JPG、WebP 和 GIF 图片。');
      const stat = fs.statSync(filename);
      if (stat.size > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB。');
      const dataUrl = `data:${mime};base64,${fs.readFileSync(filename).toString('base64')}`;
      return await processImageData(dataUrl, question);
    } catch (error) {
      setStatus('error', error.message);
      scheduleIdle(4500);
      throw error;
    }
  }

  async function pollHarnessStatus() {
    if (monitorRunning || destroyed || !mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return;
    monitorRunning = true;
    try {
      await installHarnessBridge();
      const snapshot = await mainWindow.webContents.executeJavaScript(
        'window.__dshDesktopPetSnapshot && window.__dshDesktopPetSnapshot()', true);
      const current = snapshot?.status;
      if (!current) return;
      const nextMessages = Array.isArray(current.messages) ? current.messages : [];
      const nextSignature = JSON.stringify(nextMessages);
      if (nextSignature !== messagesSignature) {
        messages = nextMessages;
        messagesSignature = nextSignature;
        broadcastState();
      }
      for (const action of Array.isArray(snapshot.actions) ? snapshot.actions : []) {
        if (action?.type === 'show-pet') showPet();
        if (action?.type === 'bridge-error') {
          setStatus('error', action.message || '读取图片失败');
          scheduleIdle(4500);
        }
        if (action?.type === 'image-data') {
          processImageData(action.dataUrl, action.question).catch(() => {});
        }
      }
      if (current.busy) {
        clearTimeout(successTimer);
        setStatus(current.command ? 'executing' : 'thinking');
      } else if (lastBusy) {
        setStatus(current.hasError ? 'error' : 'success');
        scheduleIdle(current.hasError ? 4200 : 2600);
        lastSubmitAt = 0;
      } else if (lastSubmitAt && Date.now() - lastSubmitAt < 4500) {
        setStatus('thinking');
      } else if (lastSubmitAt && Date.now() - lastSubmitAt >= 4500) {
        lastSubmitAt = 0;
        if (status === 'thinking') setStatus('success');
        scheduleIdle();
      }
      lastBusy = Boolean(current.busy);
    } catch {} finally {
      monitorRunning = false;
    }
  }

  function assertSender(event) {
    const valid = [petWindow, settingsWindow].some((window) => window && !window.isDestroyed() && event.sender === window.webContents);
    if (!valid) throw new Error('不允许的桌宠请求。');
  }

  function handle(channel, listener) {
    ipcMain.handle(channel, async (event, ...args) => {
      assertSender(event);
      return listener(...args);
    });
    handlers.push(channel);
  }

  function installIpc() {
    handle('desktop-pet:get-state', () => publicState());
    handle('desktop-pet:send-message', (message) => sendMessage(message));
    handle('desktop-pet:choose-image', (question) => chooseImage(question));
    handle('desktop-pet:open-settings', () => { openSettings(); return { ok: true }; });
    handle('desktop-pet:hide', () => { hidePet(); return { ok: true }; });
    handle('desktop-pet:show-main-window', () => {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
      return { ok: true };
    });
    handle('desktop-pet:get-settings', () => settingsPayload());
    handle('desktop-pet:save-settings', (input = {}) => {
      const next = normalizeSettings({ ...loadSettings(), ...input, position: loadSettings().position });
      if (String(input.visionApiKey || '').trim()) saveVisionApiKey(input.visionApiKey);
      if (input.clearVisionApiKey === true) removeVisionApiKey();
      if (!characters().some((item) => item.id === next.characterId)) next.characterId = 'default-maid';
      settings = next;
      saveSettings();
      if (settings.enabled) createPetWindow();
      applyWindowSettings();
      return settingsPayload();
    });
    handle('desktop-pet:open-directory', async () => {
      fs.mkdirSync(userPetDirectory(), { recursive: true });
      const result = await shell.openPath(userPetDirectory());
      if (result) throw new Error(result);
      return { ok: true };
    });
    handle('desktop-pet:refresh-characters', () => ({ characters: characters() }));
  }

  function start() {
    loadSettings();
    fs.mkdirSync(userPetDirectory(), { recursive: true });
    installIpc();
    mainWindow.webContents.on('did-finish-load', installHarnessBridge);
    if (settings.enabled) createPetWindow();
    statusTimer = setInterval(pollHarnessStatus, 700);
    return api;
  }

  function destroy() {
    destroyed = true;
    clearInterval(statusTimer);
    clearTimeout(successTimer);
    clearTimeout(moveTimer);
    for (const channel of handlers) ipcMain.removeHandler(channel);
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.destroy();
    if (petWindow && !petWindow.isDestroyed()) petWindow.destroy();
  }

  const api = {
    start,
    destroy,
    show: showPet,
    hide: hidePet,
    openSettings,
    openDirectory: async () => {
      fs.mkdirSync(userPetDirectory(), { recursive: true });
      const result = await shell.openPath(userPetDirectory());
      if (result) throw new Error(result);
    },
    isVisible: () => Boolean(petWindow && !petWindow.isDestroyed() && petWindow.isVisible()),
  };
  return api;
}

module.exports = { createDesktopPet };
