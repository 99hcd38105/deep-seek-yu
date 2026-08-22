const { dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ProxyAgent } = require('undici');
const { findNodeExecutable } = require('./node-runtime');

const REGISTRY_URL = 'https://raw.githubusercontent.com/dshworks/awesome-dsh-plugins/main/data/plugins.json';

function installSpec(plugin) {
  if (plugin.npm && /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(plugin.npm)) return plugin.npm;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(plugin.repo || '')) return '';
  const suffix = plugin.path ? `#path:${String(plugin.path).replace(/^\//, '')}` : '';
  return `github:${plugin.repo}${suffix}`;
}

function atomicJson(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, 'utf8')); } catch { return null; }
}

function proxyUrl(rule) {
  const match = /(?:PROXY|HTTPS?)\s+([^;\s]+)/i.exec(String(rule || ''));
  if (!match) return '';
  return /^https?:\/\//i.test(match[1]) ? match[1] : `http://${match[1]}`;
}

function normalizeRegistry(data, warning = '') {
  return {
    updated: data.updated,
    source: REGISTRY_URL,
    warning,
    notice: '独立社区目录，非 DeepSeek 官方或认可。安装第三方插件等同于运行其代码。',
    plugins: (Array.isArray(data.plugins) ? data.plugins : [])
      .filter((item) => !item.official && ['plugin', 'bundle'].includes(item.category) && item.status === 'verified')
      .map((item) => ({
        name: String(item.name || '').slice(0, 100), repo: String(item.repo || '').slice(0, 180),
        description: String(item.description || '').slice(0, 500), category: item.category,
        npm: item.npm || '', path: item.path || '', tags: Array.isArray(item.tags) ? item.tags.slice(0, 8) : [],
        stars: Number.isFinite(item.stars) ? item.stars : null, verifiedAgainst: item.verifiedAgainst || '',
        sourceUrl: `https://github.com/${item.repo}`, installSpec: installSpec(item),
      })).filter((item) => item.installSpec)
      .sort((a, b) => (b.stars || 0) - (a.stars || 0)).slice(0, 500),
  };
}

function runDsh(app, entry, args, environment) {
  return new Promise((resolve, reject) => {
    const node = findNodeExecutable(app);
    if (!node) return reject(new Error('安装包缺少 Harness 私有 Node.js 运行时，请重新安装客户端。'));
    const child = spawn(node, ['--expose-internals', entry, ...args], {
      env: { ...process.env, ...environment }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    const receive = (data) => { tail = `${tail}${data.toString()}`.slice(-18000); };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(tail) : reject(new Error(tail.trim() || `插件安装退出代码 ${code}`)));
  });
}

function createExtensionsManager({ app, mainWindow, runtimeManager, dshHome, onRestartRequired }) {
  let operation = null;
  const cachePath = path.join(app.getPath('userData'), 'community-plugins-cache.json');

  async function registry() {
    try {
      const rule = await mainWindow.webContents.session.resolveProxy(REGISTRY_URL);
      const proxy = proxyUrl(rule);
      const response = await fetch(REGISTRY_URL, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000),
        ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
      });
      if (!response.ok) throw new Error(`社区目录返回 ${response.status}`);
      const data = await response.json();
      atomicJson(cachePath, data);
      return normalizeRegistry(data);
    } catch (error) {
      const cached = readJson(cachePath);
      if (cached) return normalizeRegistry(cached, `当前使用本地缓存：${String(error?.message || error).slice(0, 120)}`);
      throw error;
    }
  }

  async function installRuntime(version) {
    if (operation) throw new Error('已有操作正在进行。');
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: '安装 DeepSeek 官方 Harness', message: `安装并切换到 @deepseek-ai/dsh@${version}？`,
      detail: '版本只从 DeepSeek 官方 npm 命名空间下载。完成后需要重启客户端。',
      buttons: ['取消', '安装'], defaultId: 0, cancelId: 0,
    });
    if (choice.response !== 1) return { canceled: true };
    operation = runtimeManager.install(version);
    try { const result = await operation; onRestartRequired(); return result; }
    finally { operation = null; }
  }

  async function installPlugin(plugin) {
    if (operation) throw new Error('已有操作正在进行。');
    const spec = installSpec(plugin || {});
    if (!spec) throw new Error('插件安装来源无效。');
    const sourceUrl = `https://github.com/${plugin.repo}`;
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: '安装第三方 Harness 插件', message: `确认安装 ${plugin.name || spec}？`,
      detail: `来源：${sourceUrl}\n安装项：${spec}\n\n第三方插件可以访问 Harness 的文件、命令和网络能力。请先查看源码。`,
      buttons: ['取消', '查看源码', '我已了解，安装'], defaultId: 0, cancelId: 0,
    });
    if (choice.response === 1) { await shell.openExternal(sourceUrl); return { canceled: true }; }
    if (choice.response !== 2) return { canceled: true };
    const active = runtimeManager.active();
    const binPath = path.join(app.getAppPath(), 'node_modules', '.bin');
    operation = runDsh(app, active.entry, ['plugin', '--profile', 'web', 'add', spec], {
      DSH_HOME: dshHome(), PATH: `${binPath}${path.delimiter}${process.env.PATH || ''}`,
    });
    try { await operation; onRestartRequired(); return { ok: true, restartRequired: true }; }
    finally { operation = null; }
  }

  async function dispatch(action) {
    switch (action?.type) {
      case 'extensions:versions': return runtimeManager.versions();
      case 'extensions:registry': return registry();
      case 'extensions:install-runtime': return installRuntime(String(action.payload?.version || ''));
      case 'extensions:install-plugin': return installPlugin(action.payload?.plugin || {});
      case 'extensions:open-source': await shell.openExternal(String(action.payload?.url || '')); return { ok: true };
      default: throw new Error('未知的 DeepSeek yu 插件操作。');
    }
  }

  return { dispatch, destroy() {} };
}

module.exports = { createExtensionsManager };
