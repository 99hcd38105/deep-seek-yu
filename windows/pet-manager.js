const { BrowserWindow, dialog, ipcMain, screen, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createLocalVision } = require('./local-vision');

const SETTINGS_FILE = 'desktop-pet.json';
const LEGACY_VISION_CREDENTIALS_FILE = 'doubao-vision-credentials.json';
const SETTINGS_VERSION = 2;
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
    backgroundOnClose: value.backgroundOnClose !== false,
    size: Math.round(clamp(value.size ?? 220, 160, 360) / 10) * 10,
    opacity: clamp(value.opacity ?? 1, 0.55, 1),
    characterId: safeIdentifier(value.characterId) || 'default-maid',
    position: value.position && Number.isInteger(value.position.x) && Number.isInteger(value.position.y)
      ? { x: value.position.x, y: value.position.y }
      : null,
  };
}

function createDesktopPet({ app, mainWindow, onMenuChange = () => {}, onPluginAction = async () => ({}) }) {
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
  const legacyVisionCredentialsPath = () => path.join(app.getPath('userData'), LEGACY_VISION_CREDENTIALS_FILE);
  const userPetDirectory = () => path.join(app.getPath('userData'), 'pets');
  const builtinPetDirectory = () => path.join(app.getAppPath(), 'assets', 'pets', 'default-maid');
  const localVision = createLocalVision({
    cacheDir: process.env.DSH_TEST_MODEL_CACHE || path.join(app.getPath('userData'), 'models'),
    resolveProxy: (url) => mainWindow.webContents.session.resolveProxy(url),
    onState: (vision) => {
      if (vision.status === 'downloading') setStatus('thinking', `首次准备识图模型… ${vision.progress}%`);
      else if (vision.status === 'loading') setStatus('thinking', '正在加载本地识图模型…');
      else if (vision.status === 'analyzing') setStatus('thinking', '正在本地识别图片…');
      else if (vision.status === 'ready' && !imageProcessing) {
        setStatus('success', '本地识图已就绪');
        scheduleIdle();
      } else if (vision.status === 'error') {
        setStatus('error', '本地识图准备失败');
        scheduleIdle(4500);
      }
      if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('desktop-pet:vision-state', vision);
    },
  });

  function loadSettings() {
    if (!settings) settings = normalizeSettings(readJson(settingsPath()) || {});
    return settings;
  }

  function saveSettings() {
    settings = normalizeSettings(settings);
    writeJsonAtomic(settingsPath(), settings);
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
      petSize: loadSettings().size,
      visionReady: localVision.getState().cached,
      messages,
      characterId: selected?.id || '',
      actions: selected?.actions || {},
    };
  }

  function settingsPayload() {
    return {
      settings: { ...loadSettings() },
      vision: localVision.getState(),
      characters: characters(),
    };
  }

  function updateSettings(input = {}) {
    const current = loadSettings();
    const next = normalizeSettings({ ...current, ...input, position: current.position });
    if (!characters().some((item) => item.id === next.characterId)) next.characterId = 'default-maid';
    settings = next;
    saveSettings();
    if (settings.enabled) createPetWindow();
    applyWindowSettings();
    return settingsPayload();
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
    const width = current.showChatPanel ? Math.max(300, Math.min(460, current.size + 100)) : current.size;
    const workArea = screen.getPrimaryDisplay().workArea;
    const desiredHeight = current.showChatPanel
      ? Math.max(450, Math.round(current.size * 1.9))
      : Math.round(current.size * 1.28);
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
      title: 'DeepSeek yu 桌宠',
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
      icon: path.join(app.getAppPath(), 'assets', 'deep-seek-yu-icon.ico'),
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

  async function openSettings() {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    await mainWindow.webContents.executeJavaScript(`(async()=>{
      const sleep=(ms)=>new Promise(resolve=>setTimeout(resolve,ms));
      const text=(node)=>[node.textContent,node.getAttribute?.('aria-label'),node.getAttribute?.('title')].filter(Boolean).join(' ').trim();
      let pluginTab=document.querySelector('#deep-seek-yu-plugin-tab');
      if(!pluginTab){
        const settings=[...document.querySelectorAll('button')].find(node=>/^设置$/.test(text(node))||/settings/i.test(text(node)));
        settings?.click();
        for(let index=0;index<30&&!pluginTab;index+=1){
          await sleep(100);
          const plugins=[...document.querySelectorAll('button')].find(node=>text(node).trim()==='插件');
          plugins?.click();
          await sleep(50);
          pluginTab=document.querySelector('#deep-seek-yu-plugin-tab');
        }
      }
      pluginTab?.click();
      return Boolean(pluginTab);
    })()`, true);
  }

  async function installHarnessBridge() {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return false;
    try {
      return Boolean(await mainWindow.webContents.executeJavaScript(
        'Boolean(window.__dshDesktopPetBridgeInstalled && window.__dshDesktopPetSend && window.__dshDesktopPetSnapshot)', true));
    } catch { return false; }
  }

  async function sendMessage(message, options = {}) {
    const text = String(message || '').trim();
    if (!text) throw new Error('请输入要发送的内容。');
    if (text.length > 12000) throw new Error('消息过长，请控制在 12000 个字符以内。');
    if (!mainWindow || mainWindow.isDestroyed()) throw new Error('当前聊天窗口不可用。');
    if (!(await installHarnessBridge())) throw new Error('Harness 桌宠插件尚未加载，请刷新聊天页面后重试。');
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
    const buffer = Buffer.from(match[2], 'base64');
    if (buffer.length > 10 * 1024 * 1024) throw new Error('图片不能超过 10 MB。');
    return { buffer, mimeType: match[1] };
  }

  async function analyzeImageData(dataUrl, question) {
    const image = validateImageDataUrl(dataUrl);
    const userQuestion = String(question || '').trim().slice(0, 2000);
    const description = await localVision.analyze(image.buffer, image.mimeType);
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
        '用户附加了一张图片。图片已由电脑上的本地视觉模型读取，原图没有上传给你。以下是视觉模型返回的文字描述（可能是英文），请把它作为图片上下文，用中文继续完成用户请求：',
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
      throw error;
    } finally {
      imageProcessing = false;
    }
  }

  async function chooseImage(question) {
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
      if (!(await installHarnessBridge())) return;
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
        if (action?.requestId) {
          try {
            let result;
            if (action.type === 'desktop-pet:get-settings') result = settingsPayload();
            else if (action.type === 'desktop-pet:save-settings') result = updateSettings(action.payload || {});
            else if (action.type === 'desktop-pet:open-directory') {
              fs.mkdirSync(userPetDirectory(), { recursive: true });
              const opened = await shell.openPath(userPetDirectory());
              if (opened) throw new Error(opened);
              result = { ok: true };
            } else result = await onPluginAction(action);
            await mainWindow.webContents.executeJavaScript(
              `window.__deepSeekYuPluginResolve?.(${JSON.stringify(action.requestId)}, ${JSON.stringify(result)}, null)`, true);
          } catch (error) {
            await mainWindow.webContents.executeJavaScript(
              `window.__deepSeekYuPluginResolve?.(${JSON.stringify(action.requestId)}, null, ${JSON.stringify(String(error?.message || error).slice(0, 500))})`, true).catch(() => {});
          }
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
    handle('desktop-pet:save-settings', updateSettings);
    handle('desktop-pet:prepare-vision', async () => {
      await localVision.prepare();
      return localVision.getState();
    });
    handle('desktop-pet:open-model-directory', async () => {
      fs.mkdirSync(localVision.modelDirectory(), { recursive: true });
      const result = await shell.openPath(localVision.modelDirectory());
      if (result) throw new Error(result);
      return { ok: true };
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
    try { fs.rmSync(legacyVisionCredentialsPath(), { force: true }); } catch {}
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
    settings: settingsPayload,
    updateSettings,
    shouldRunInBackground: () => loadSettings().backgroundOnClose,
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
