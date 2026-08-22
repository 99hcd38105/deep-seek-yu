const { BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');

const REGISTRY_URL = 'https://raw.githubusercontent.com/dshworks/awesome-dsh-plugins/main/data/plugins.json';

function installSpec(plugin) {
  if (plugin.npm && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(plugin.npm)) return plugin.npm;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(plugin.repo || '')) return '';
  const suffix = plugin.path ? `#path:${String(plugin.path).replace(/^\//, '')}` : '';
  return `github:${plugin.repo}${suffix}`;
}

function runDsh(entry, args, environment, onLine) {
  return new Promise((resolve, reject) => {
    const commandArgs = appArgs(entry, args);
    const child = spawn(process.execPath, commandArgs, {
      env: { ...process.env, ...environment, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const receive = (data) => {
      const text = data.toString();
      tail = `${tail}${text}`.slice(-18000);
      for (const line of text.split(/\r?\n/).filter(Boolean)) onLine(line.slice(0, 500));
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(tail) : reject(new Error(tail.trim() || `插件安装退出代码 ${code}`)));
  });
}

function appArgs(entry, args) {
  return ['--expose-internals', entry, ...args];
}

function createExtensionsManager({ app, mainWindow, runtimeManager, dshHome, onRestartRequired }) {
  let window = null;
  let operation = null;
  const channels = [];
  const send = (channel, value) => {
    if (window && !window.isDestroyed()) window.webContents.send(channel, value);
  };
  const handle = (channel, listener) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!window || window.isDestroyed() || event.sender !== window.webContents) throw new Error('不允许的扩展管理请求。');
      return listener(...args);
    });
    channels.push(channel);
  };
  async function registry() {
    const response = await fetch(REGISTRY_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`社区目录返回 ${response.status}`);
    const data = await response.json();
    return {
      updated: data.updated,
      source: REGISTRY_URL,
      notice: '独立社区目录，非 DeepSeek 官方或认可。安装第三方插件等同于运行其代码。',
      plugins: (Array.isArray(data.plugins) ? data.plugins : [])
        .filter((item) => !item.official && ['plugin', 'bundle'].includes(item.category) && item.status === 'verified')
        .map((item) => ({
          name: String(item.name || '').slice(0, 100),
          repo: String(item.repo || '').slice(0, 180),
          description: String(item.description || '').slice(0, 500),
          category: item.category,
          npm: item.npm || '',
          path: item.path || '',
          tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
          stars: Number.isFinite(item.stars) ? item.stars : null,
          verifiedAgainst: item.verifiedAgainst || '',
          sourceUrl: `https://github.com/${item.repo}`,
          installSpec: installSpec(item),
        })).filter((item) => item.installSpec).sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 500),
    };
  }
  function installHandlers() {
    handle('extensions:versions', () => runtimeManager.versions());
    handle('extensions:registry', () => registry());
    handle('extensions:install-runtime', async (version) => {
      if (operation) throw new Error('已有操作正在进行。');
      const choice = await dialog.showMessageBox(window, {
        type: 'warning', title: '安装 DeepSeek 官方 Harness',
        message: `安装并切换到 @deepseek-ai/dsh@${version}？`,
        detail: '版本只从 DeepSeek 官方 npm 命名空间下载。完成后需要重启客户端。',
        buttons: ['取消', '安装'], defaultId: 0, cancelId: 0,
      });
      if (choice.response !== 1) return { canceled: true };
      operation = runtimeManager.install(version, (line) => send('extensions:progress', line));
      try {
        const result = await operation;
        onRestartRequired();
        return result;
      } finally { operation = null; }
    });
    handle('extensions:install-plugin', async (plugin) => {
      if (operation) throw new Error('已有操作正在进行。');
      const spec = installSpec(plugin || {});
      if (!spec) throw new Error('插件安装来源无效。');
      const sourceUrl = `https://github.com/${plugin.repo}`;
      const choice = await dialog.showMessageBox(window, {
        type: 'warning', title: '安装第三方 Harness 插件',
        message: `确认安装 ${plugin.name || spec}？`,
        detail: `来源：${sourceUrl}\n安装项：${spec}\n\n第三方插件可以访问 Harness 的文件、命令和网络能力。该目录并非 DeepSeek 官方认可，请先查看源码。`,
        buttons: ['取消', '查看源码', '我已了解，安装'], defaultId: 0, cancelId: 0,
      });
      if (choice.response === 1) { await shell.openExternal(sourceUrl); return { canceled: true }; }
      if (choice.response !== 2) return { canceled: true };
      const active = runtimeManager.active();
      const binPath = path.join(app.getAppPath(), 'node_modules', '.bin');
      operation = runDsh(active.entry, ['plugin', '--profile', 'web', 'add', spec], {
        DSH_HOME: dshHome(), PATH: `${binPath}${path.delimiter}${process.env.PATH || ''}`,
      }, (line) => send('extensions:progress', line));
      try {
        await operation;
        onRestartRequired();
        return { ok: true, restartRequired: true };
      } finally { operation = null; }
    });
    handle('extensions:open-source', (url) => shell.openExternal(String(url || '')));
  }
  installHandlers();
  function open() {
    if (window && !window.isDestroyed()) { window.show(); window.focus(); return; }
    window = new BrowserWindow({
      title: '官方更新与插件市场', width: 980, height: 760, minWidth: 760, minHeight: 600,
      parent: mainWindow, backgroundColor: '#f8fafc', autoHideMenuBar: true,
      icon: path.join(app.getAppPath(), 'assets', 'deep-seek-yu-icon.ico'),
      webPreferences: { preload: path.join(app.getAppPath(), 'extensions-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    window.setMenu(null);
    window.loadFile(path.join(app.getAppPath(), 'extensions-window.html'));
    window.on('closed', () => { window = null; });
  }
  function destroy() {
    for (const channel of channels) ipcMain.removeHandler(channel);
    if (window && !window.isDestroyed()) window.destroy();
  }
  return { open, destroy };
}

module.exports = { createExtensionsManager };
