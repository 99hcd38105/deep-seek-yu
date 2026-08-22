const { app, BrowserWindow, Menu, Tray, clipboard, dialog, session, shell } = require('electron');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const YAML = require('yaml');
const { createDesktopPet } = require('./pet-manager');
const { createHarnessRuntimeManager } = require('./harness-runtime-manager');
const { createExtensionsManager } = require('./extensions-manager');
const { findNodeExecutable } = require('./node-runtime');

const MOBILE_SETTINGS_FILE = 'mobile-access.json';
const MOBILE_SETTINGS_VERSION = 2;
const MOBILE_PORT_MIN = 20000;
const MOBILE_PORT_MAX = 49152;

let mainWindow;
let desktopPet = null;
let extensionsManager = null;
let runtimeManager = null;
let gatewayProcess = null;
let harnessProcess = null;
let gatewayStarting = false;
let initializing = true;
let mobileSettingsCache = null;
let quitting = false;
let tray = null;

if (process.env.DSH_TEST_USER_DATA) {
  app.setPath('userData', path.resolve(process.env.DSH_TEST_USER_DATA));
}
app.setAppUserModelId('ai.deepseek.harness.desktop');

function dshHome() {
  return path.join(app.getPath('userData'), 'dsh-home');
}

function localVisionCache() {
  return process.env.DSH_TEST_MODEL_CACHE || path.join(app.getPath('userData'), 'models');
}

function credentialsPath() {
  return path.join(dshHome(), '.credentials.yaml');
}

function normalizeCredentialDocument(text = '') {
  const parsed = text.trim() ? YAML.parse(text) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('DeepSeek 凭据文件格式不正确。');
  }

  if (parsed.version === 1) {
    const refs = parsed.refs && typeof parsed.refs === 'object' && !Array.isArray(parsed.refs)
      ? { ...parsed.refs }
      : {};
    // v1.0.x once appended this key at the document root after the official
    // runtime had already migrated the file. The root value is the newest one.
    if (typeof parsed.DEEPSEEK_API_KEY === 'string' && parsed.DEEPSEEK_API_KEY) {
      refs.DEEPSEEK_API_KEY = parsed.DEEPSEEK_API_KEY;
    }
    delete parsed.DEEPSEEK_API_KEY;
    return { ...parsed, version: 1, refs };
  }

  const refs = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === 'string' && value) refs[name] = value;
  }
  return { version: 1, refs };
}

function writeCredentialDocument(document) {
  const filename = credentialsPath();
  const temporaryPath = `${filename}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporaryPath, YAML.stringify(document), { mode: 0o600 });
  fs.renameSync(temporaryPath, filename);
  try { fs.chmodSync(filename, 0o600); } catch {}
}

function migrateDeepSeekCredentials() {
  const filename = credentialsPath();
  let text;
  try { text = fs.readFileSync(filename, 'utf8'); } catch { return; }
  const parsed = YAML.parse(text);
  const needsMigration = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    && (parsed.version !== 1 || Object.hasOwn(parsed, 'DEEPSEEK_API_KEY'));
  if (needsMigration) writeCredentialDocument(normalizeCredentialDocument(text));
}

function hasDeepSeekApiKey() {
  try {
    const document = normalizeCredentialDocument(fs.readFileSync(credentialsPath(), 'utf8'));
    return typeof document.refs?.DEEPSEEK_API_KEY === 'string'
      && document.refs.DEEPSEEK_API_KEY.length > 0;
  } catch {
    return false;
  }
}

function normalizeDeepSeekApiKey(value) {
  const normalized = String(value || '').trim();
  if (!normalized || !/^[\x21-\x7E]+$/.test(normalized)) {
    throw new Error('请输入有效的 DeepSeek API Key。');
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(normalized) || /^(["']).*\1$/.test(normalized)) {
    throw new Error('只填写密钥本身，不要包含变量名或引号。');
  }
  return normalized;
}

function saveDeepSeekApiKey(value) {
  const apiKey = normalizeDeepSeekApiKey(value);
  const filename = credentialsPath();
  let existing = '';
  try { existing = fs.readFileSync(filename, 'utf8'); } catch {}
  const document = normalizeCredentialDocument(existing);
  document.refs.DEEPSEEK_API_KEY = apiKey;
  writeCredentialDocument(document);
}

function newMobileSettings() {
  const harnessPort = crypto.randomInt(MOBILE_PORT_MIN, MOBILE_PORT_MAX);
  let port;
  do {
    port = crypto.randomInt(MOBILE_PORT_MIN, MOBILE_PORT_MAX);
  } while (port === harnessPort);
  return {
    version: MOBILE_SETTINGS_VERSION,
    token: crypto.randomBytes(32).toString('base64url'),
    port,
    harnessPort,
  };
}

function validMobileSettings(value) {
  return value
    && value.version === MOBILE_SETTINGS_VERSION
    && typeof value.token === 'string'
    && /^[A-Za-z0-9_-]{32,}$/.test(value.token)
    && Number.isInteger(value.port)
    && value.port >= MOBILE_PORT_MIN
    && value.port < MOBILE_PORT_MAX
    && Number.isInteger(value.harnessPort)
    && value.harnessPort >= MOBILE_PORT_MIN
    && value.harnessPort < MOBILE_PORT_MAX
    && value.harnessPort !== value.port;
}

function saveMobileSettings(value) {
  const settingsPath = path.join(app.getPath('userData'), MOBILE_SETTINGS_FILE);
  const temporaryPath = `${settingsPath}.tmp`;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, settingsPath);
  try { fs.chmodSync(settingsPath, 0o600); } catch {}
}

function mobileSettings() {
  if (mobileSettingsCache) return mobileSettingsCache;
  const settingsPath = path.join(app.getPath('userData'), MOBILE_SETTINGS_FILE);
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (validMobileSettings(parsed)) {
      mobileSettingsCache = parsed;
      return mobileSettingsCache;
    }
  } catch {}
  mobileSettingsCache = newMobileSettings();
  saveMobileSettings(mobileSettingsCache);
  return mobileSettingsCache;
}

function rotateMobileSettings() {
  mobileSettingsCache = newMobileSettings();
  saveMobileSettings(mobileSettingsCache);
  return mobileSettingsCache;
}

function localUrl() {
  return `http://127.0.0.1:${mobileSettings().harnessPort}/`;
}

function requestDeepSeekApiKey() {
  return new Promise((resolve) => {
    let settled = false;
    const setupWindow = new BrowserWindow({
      title: '设置 DeepSeek API Key',
      width: 470,
      height: 350,
      resizable: false,
      minimizable: false,
      maximizable: false,
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      icon: path.join(app.getAppPath(), 'assets', 'deep-seek-yu-icon.ico'),
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    setupWindow.setMenu(null);
    setupWindow.webContents.on('will-navigate', (event, targetUrl) => {
      if (!targetUrl.startsWith('dsh-setup://save')) return;
      event.preventDefault();
      try {
        const apiKey = new URL(targetUrl).searchParams.get('apiKey') || '';
        saveDeepSeekApiKey(apiKey);
        mobileSettings();
        settled = true;
        resolve(true);
        setupWindow.close();
      } catch (error) {
        dialog.showMessageBox(setupWindow, {
          type: 'warning',
          title: '密钥格式不正确',
          message: error.message,
          buttons: ['重新填写'],
        });
      }
    });
    setupWindow.on('closed', () => {
      if (!settled) resolve(null);
    });
    const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action dsh-setup:">
<title>设置 DeepSeek API Key</title><style>
*{box-sizing:border-box}body{margin:0;padding:30px 34px;font:14px/1.55 Inter,"Segoe UI","Microsoft YaHei",sans-serif;color:#18181b;background:#fff}
h1{font-size:21px;margin:0 0 10px}p{margin:0 0 22px;color:#5f6368}label{display:block;font-weight:600;margin-bottom:8px}
input{width:100%;height:44px;border:1px solid #d4d4d8;border-radius:10px;padding:0 12px;font:14px ui-monospace,Consolas,monospace;outline:none}
input:focus{border-color:#2563eb;box-shadow:0 0 0 3px #dbeafe}.hint{font-size:12px;margin:8px 0 20px;color:#71717a}
button{float:right;height:42px;border:0;border-radius:10px;padding:0 22px;color:white;background:#18181b;font-weight:600;cursor:pointer}
</style></head><body><h1>设置 DeepSeek API Key</h1>
<p>首次运行需要填写使用者自己的 DeepSeek API Key。密钥只保存在这台电脑，不会写入安装包或 Git。</p>
<form action="dsh-setup://save" method="get"><label for="apiKey">DeepSeek API Key</label>
<input id="apiKey" name="apiKey" type="password" required autofocus autocomplete="new-password" placeholder="sk-...">
<div class="hint">保存后客户端会自动生成本机端口和手机连接保护密钥。</div><button type="submit">保存并继续</button></form></body></html>`;
    setupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });
}

function canConnect(host, port, timeout = 700) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

function waitForHttp(url, timeout = 30000) {
  const deadline = Date.now() + timeout;
  return new Promise((resolve, reject) => {
    const check = () => {
      const request = http.get(url, (response) => {
        response.resume();
        if (response.statusCode && response.statusCode < 500) return resolve();
        retry();
      });
      request.setTimeout(900, () => request.destroy());
      request.once('error', retry);
    };
    const retry = () => {
      if (Date.now() >= deadline) return reject(new Error('Harness 启动超时。'));
      setTimeout(check, 450);
    };
    check();
  });
}

function findFirst(candidates) {
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
}

function findNode() {
  return findNodeExecutable(app);
}

function findDshEntry() {
  const selected = runtimeManager?.active().entry;
  if (selected) return selected;
  return findFirst([
    path.join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh', 'dist', 'bin.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'dist', 'bin.js'),
  ]);
}

function directoryPickerPatch() {
  const templatePath = path.join(app.getAppPath(), 'assets', 'directory-picker-browse.patch.yml');
  const pluginUrl = (packageName, relative) => pathToFileURL(
    runtimeManager?.pluginEntry(packageName, relative) || path.join(app.getAppPath(), relative),
  ).href;
  const patchText = fs.readFileSync(templatePath, 'utf8')
    .replace('__DSH_LOCAL_VISION_PLUGIN__', pluginUrl('@deep-seek-yu/local-vision', 'harness-plugins/local-vision/index.js'))
    .replace('__DSH_DESKTOP_COMPANION_PLUGIN__', pluginUrl('@deep-seek-yu/desktop-companion', 'harness-plugins/desktop-companion/index.js'))
    .replace('__DSH_ACCOUNT_STATUS_PLUGIN__', pluginUrl('@deep-seek-yu/account-status', 'harness-plugins/account-status/index.js'));
  const patchPath = path.join(app.getPath('userData'), 'harness-runtime.patch.yml');
  const temporaryPath = `${patchPath}.tmp`;
  fs.writeFileSync(temporaryPath, patchText, { mode: 0o600 });
  fs.renameSync(temporaryPath, patchPath);
  return patchPath;
}

function spawnHidden(command, args, { detached = true, extraEnv = {}, stdio = 'ignore' } = {}) {
  const environment = { ...process.env, ...extraEnv };
  if (app.isPackaged && path.resolve(command) === path.resolve(process.execPath)) {
    environment.ELECTRON_RUN_AS_NODE = '1';
  }
  const child = spawn(command, args, {
    detached,
    windowsHide: true,
    stdio,
    env: environment,
  });
  if (detached) child.unref();
  return child;
}

function privateAddress() {
  const addresses = Object.values(os.networkInterfaces()).flat().filter(Boolean)
    .filter((entry) => entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
  return addresses.find((address) => address.startsWith('192.168.'))
    || addresses.find((address) => address.startsWith('10.'))
    || addresses.find((address) => /^172\.(1[6-9]|2\d|3[01])\./.test(address));
}

async function ensureHarness() {
  const { harnessPort } = mobileSettings();
  const node = findNode();
  if (!node) throw new Error('安装包缺少 Harness 私有 Node.js 运行时，请重新下载安装。');
  if (!(await canConnect('127.0.0.1', harnessPort))) {
    const dshEntry = findDshEntry();
    if (!dshEntry) {
      throw new Error('没有找到 DeepSeek yu 所需的 Harness 运行环境。请重新安装客户端。');
    }
    const dshArguments = [
      dshEntry,
      'web',
      '--patch', directoryPickerPatch(),
      '--host', '127.0.0.1',
      '--port', String(harnessPort),
      '--no-open',
    ];
    if (app.isPackaged) dshArguments.unshift('--expose-internals');
    const visionProxyRule = await session.defaultSession.resolveProxy('https://huggingface.co/');
    const child = spawnHidden(node, dshArguments, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      extraEnv: {
        DSH_HOME: dshHome(),
        DSH_LOCAL_VISION_CACHE: localVisionCache(),
        DSH_LOCAL_VISION_PROXY_RULE: visionProxyRule || 'DIRECT',
      },
    });
    harnessProcess = child;
    let startupOutput = '';
    const receiveStartupOutput = (chunk) => {
      startupOutput = `${startupOutput}${chunk.toString()}`.slice(-16000);
    };
    child.stdout.on('data', receiveStartupOutput);
    child.stderr.on('data', receiveStartupOutput);
    child.once('exit', () => {
      if (harnessProcess === child) harnessProcess = null;
    });
    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const complete = (callback, value) => {
          if (settled) return;
          settled = true;
          callback(value);
        };
        waitForHttp(localUrl()).then(() => complete(resolve)).catch((error) => complete(reject, error));
        child.once('error', (error) => complete(reject, error));
        child.once('exit', (code) => {
          const safeDetail = startupOutput
            .replace(/sk-[A-Za-z0-9_-]{8,}/g, 'sk-***')
            .split(/\r?\n/).filter(Boolean).slice(-10).join('\n');
          complete(reject, new Error(safeDetail
            ? `Harness 启动失败：\n${safeDetail}`
            : `Harness 启动进程提前退出（代码 ${code ?? '未知'}）。`));
        });
      });
    } catch (error) {
      if (child.exitCode === null && !child.killed) child.kill();
      throw error;
    } finally {
      child.stdout.off('data', receiveStartupOutput);
      child.stderr.off('data', receiveStartupOutput);
    }
    return;
  }
  await waitForHttp(localUrl());
}

function stopHarnessNow() {
  const child = harnessProcess;
  harnessProcess = null;
  if (child && child.exitCode === null && !child.killed) child.kill();
}

function gatewayIsRunning() {
  return gatewayProcess !== null && gatewayProcess.exitCode === null && !gatewayProcess.killed;
}

async function dispatchMobileControl(action) {
  const type = String(action?.type || '');
  switch (type) {
    case 'desktop-pet:get-settings': return desktopPet?.settings() || {};
    case 'desktop-pet:save-settings': return desktopPet?.updateSettings(action.payload || {}) || {};
    case 'desktop-pet:show': desktopPet?.show(); return { ok: true };
    case 'desktop-pet:hide': desktopPet?.hide(); return { ok: true };
    case 'desktop-pet:open-directory': await desktopPet?.openDirectory(); return { ok: true };
    case 'extensions:versions':
    case 'extensions:registry':
    case 'extensions:installed':
    case 'extensions:install-runtime':
    case 'extensions:install-plugin':
    case 'extensions:remove-plugin':
    case 'extensions:repair-plugin':
    case 'extensions:set-plugin-enabled':
    case 'extensions:open-source':
    case 'extensions:open-topic':
      if (!extensionsManager) throw new Error('插件管理器尚未就绪。');
      return extensionsManager.dispatch(action);
    default: throw new Error('不允许的手机端操作。');
  }
}

async function waitForGatewayState(expectedOpen, timeout = 10000) {
  const { port } = mobileSettings();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await canConnect('127.0.0.1', port)) === expectedOpen) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(expectedOpen ? '手机连接启动超时。' : '手机连接关闭超时。');
}

async function startGateway() {
  if (gatewayStarting || gatewayIsRunning()) return mobileUrl();
  const settings = mobileSettings();
  if (await canConnect('127.0.0.1', settings.port)) {
    throw new Error(`手机连接端口 ${settings.port} 已被其他程序占用。`);
  }

  const lanAddress = privateAddress();
  if (!lanAddress) throw new Error('没有检测到可用的 Wi-Fi/局域网地址。');

  gatewayStarting = true;
  installMenu();
  const node = findNode();
  const allowedPrefix = `${lanAddress.split('.').slice(0, 3).join('.')}.`;
  const gateway = path.join(app.getAppPath(), 'mobile-gateway.mjs');
  const apk = path.join(app.getAppPath(), 'assets', 'deep-seek-yu-Android.apk');
  const child = spawnHidden(node, [
    gateway,
    '--token', settings.token,
    '--allowed-prefix', allowedPrefix,
    '--port', String(settings.port),
    '--upstream-port', String(settings.harnessPort),
    '--apk', apk,
  ], { detached: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  gatewayProcess = child;
  child.once('error', () => {});
  child.on('message', async (message) => {
    if (message?.type !== 'mobile-control' || typeof message.id !== 'string' || child.exitCode !== null) return;
    try {
      const result = await dispatchMobileControl(message.action);
      if (child.connected) child.send({ type: 'mobile-control-result', id: message.id, result });
    } catch (error) {
      if (child.connected) child.send({
        type: 'mobile-control-result', id: message.id,
        error: String(error?.message || error).slice(0, 500),
      });
    }
  });
  child.once('exit', () => {
    if (gatewayProcess === child) gatewayProcess = null;
    gatewayStarting = false;
    if (!quitting) installMenu();
  });

  try {
    await waitForGatewayState(true);
    gatewayStarting = false;
    installMenu();
    return mobileUrl();
  } catch (error) {
    if (child.exitCode === null) child.kill();
    if (gatewayProcess === child) gatewayProcess = null;
    gatewayStarting = false;
    installMenu();
    throw error;
  }
}

async function stopGateway() {
  const child = gatewayProcess;
  gatewayProcess = null;
  gatewayStarting = false;
  if (child && child.exitCode === null && !child.killed) child.kill();
  if (await canConnect('127.0.0.1', mobileSettings().port)) await waitForGatewayState(false);
  if (!quitting) installMenu();
}

function stopGatewayNow() {
  const child = gatewayProcess;
  gatewayProcess = null;
  gatewayStarting = false;
  if (child && child.exitCode === null && !child.killed) child.kill();
}

function mobileUrl() {
  const address = privateAddress();
  const settings = mobileSettings();
  return address ? `http://${address}:${settings.port}/?token=${encodeURIComponent(settings.token)}` : '';
}

function installMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: '客户端',
      submenu: [
        { label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => mainWindow?.reload() },
        { label: '返回', accelerator: 'Alt+Left', click: () => mainWindow?.webContents.canGoBack() && mainWindow.webContents.goBack() },
        {
          label: '更换 DeepSeek API Key',
          click: async () => {
            const saved = await requestDeepSeekApiKey();
            if (!saved) return;
            await dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: 'DeepSeek API Key 已更新',
              message: '新密钥已安全保存到本机',
              detail: '源码、安装包和 Android 客户端中都不会包含此密钥。',
              buttons: ['确定'],
            });
          },
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '手机连接',
      submenu: [
        {
          label: gatewayStarting ? '正在开启手机连接…' : (gatewayIsRunning() ? '关闭手机连接' : '开启手机连接'),
          enabled: !gatewayStarting,
          click: async () => {
            try {
              if (gatewayIsRunning()) {
                await stopGateway();
                const { port } = mobileSettings();
                await dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  title: '手机连接',
                  message: '手机连接已关闭',
                  detail: `端口 ${port} 已停止监听。`,
                  buttons: ['确定'],
                });
              } else {
                const url = await startGateway();
                const result = await dialog.showMessageBox(mainWindow, {
                  type: 'info',
                  title: '手机连接已开启',
                  message: url,
                  detail: '此链接包含本机随机访问密钥，请只发给自己的手机。关闭电脑客户端后，手机连接会自动停止。',
                  buttons: ['复制连接地址', '关闭'],
                  defaultId: 0,
                  cancelId: 1,
                });
                if (result.response === 0) clipboard.writeText(url);
              }
            } catch (error) {
              await dialog.showMessageBox(mainWindow, {
                type: 'error',
                title: '手机连接失败',
                message: error.message,
                buttons: ['确定'],
              });
            }
          },
        },
        { type: 'separator' },
        {
          label: '显示手机连接地址',
          enabled: gatewayIsRunning(),
          click: async () => {
            const url = mobileUrl();
            const result = await dialog.showMessageBox(mainWindow, {
              type: url ? 'info' : 'warning',
              title: '手机连接',
              message: url || '没有检测到 Wi-Fi/局域网地址。',
              detail: url ? '手机与电脑连接同一个 Wi-Fi 后，将完整地址粘贴到 Android 客户端。' : '请先连接可信的家庭或个人 Wi-Fi。',
              buttons: url ? ['复制连接地址', '关闭'] : ['确定'],
              defaultId: 0,
              cancelId: url ? 1 : 0,
            });
            if (url && result.response === 0) clipboard.writeText(url);
          },
        },
        {
          label: '重置手机连接地址',
          click: async () => {
            if (gatewayIsRunning()) await stopGateway();
            const settings = rotateMobileSettings();
            await dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '手机连接地址已重置',
              message: '旧连接地址已失效',
              detail: `已生成新的随机端口 ${settings.port} 和手机连接保护密钥。请重新开启手机连接并复制新地址。`,
              buttons: ['确定'],
            });
          },
        },
      ],
    },
    {
      label: '查看',
      submenu: [
        { role: 'togglefullscreen', label: '全屏' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ]));
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function updateTrayMenu() {
  if (!tray || tray.isDestroyed()) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 DeepSeek yu', click: showMainWindow },
    {
      label: desktopPet?.isVisible() ? '隐藏桌宠' : '显示桌宠',
      enabled: Boolean(desktopPet),
      click: () => desktopPet?.isVisible() ? desktopPet.hide() : desktopPet?.show(),
    },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]));
}

function createTray() {
  if (tray && !tray.isDestroyed()) return;
  tray = new Tray(path.join(app.getAppPath(), 'assets', 'deep-seek-yu-icon.ico'));
  tray.setToolTip('DeepSeek yu');
  tray.on('click', showMainWindow);
  updateTrayMenu();
}

function createWindow() {
  const appUrl = localUrl();
  mainWindow = new BrowserWindow({
    title: 'DeepSeek yu',
    width: 1280,
    height: 820,
    minWidth: 860,
    minHeight: 600,
    backgroundColor: '#071a46',
    autoHideMenuBar: false,
    icon: path.join(app.getAppPath(), 'assets', 'deep-seek-yu-icon.ico'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:deepseek-harness',
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(appUrl)) return { action: 'allow' };
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  mainWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  mainWindow.loadURL(appUrl);
  mainWindow.on('close', (event) => {
    if (quitting || !desktopPet?.shouldRunInBackground()) return;
    event.preventDefault();
    mainWindow.hide();
    desktopPet.show();
    updateTrayMenu();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!quitting) app.quit();
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    showMainWindow();
  });

  app.whenReady().then(async () => {
    try {
      migrateDeepSeekCredentials();
      if (!hasDeepSeekApiKey()) {
        const saved = await requestDeepSeekApiKey();
        if (!saved) {
          initializing = false;
          app.quit();
          return;
        }
      }
      mobileSettings();
      runtimeManager = createHarnessRuntimeManager({
        app,
        resolveProxy: (url) => session.defaultSession.resolveProxy(url),
      });
      await ensureHarness();
      createWindow();
      extensionsManager = createExtensionsManager({
        app,
        mainWindow,
        runtimeManager,
        dshHome,
        onRestartRequired: () => {},
      });
      desktopPet = createDesktopPet({
        app,
        mainWindow,
        onPluginAction: (action) => extensionsManager.dispatch(action),
        onMenuChange: () => {
          if (!quitting) {
            installMenu();
            updateTrayMenu();
          }
        },
      }).start();
      createTray();
      installMenu();
      initializing = false;
    } catch (error) {
      await dialog.showMessageBox({
        type: 'error',
        title: 'DeepSeek yu 启动失败',
        message: error.message,
        buttons: ['关闭'],
      });
      app.quit();
    }
  });
}

app.on('window-all-closed', () => {
  if (!initializing) app.quit();
});
app.on('before-quit', () => {
  quitting = true;
  desktopPet?.destroy();
  desktopPet = null;
  extensionsManager?.destroy();
  extensionsManager = null;
  if (tray && !tray.isDestroyed()) tray.destroy();
  tray = null;
  stopGatewayNow();
  stopHarnessNow();
});
process.on('exit', () => {
  stopGatewayNow();
  stopHarnessNow();
});
