const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ProxyAgent } = require('undici');
const { findNodeExecutable } = require('./node-runtime');

const SETTINGS_FILE = 'official-harness-runtime.json';
const REGISTRY_URL = 'https://registry.npmjs.org/@deepseek-ai%2fdsh';
function atomicJson(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/i.exec(String(value || ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] || 'zz', Number(match[5] || 999999)] : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return String(left).localeCompare(String(right));
  for (const index of [0, 1, 2]) if (a[index] !== b[index]) return a[index] - b[index];
  if (a[3] !== b[3]) return a[3] === 'zz' ? 1 : b[3] === 'zz' ? -1 : a[3].localeCompare(b[3]);
  return a[4] - b[4];
}

function run(command, args, options = {}, onLine = () => {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const receive = (chunk) => {
      const text = chunk.toString();
      output = `${output}${text}`.slice(-20000);
      for (const line of text.split(/\r?\n/).filter(Boolean)) onLine(line.slice(0, 500));
    };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output.trim() || `进程退出代码 ${code}`)));
  });
}

function proxyUrl(rule) {
  const match = /(?:PROXY|HTTPS?)\s+([^;\s]+)/i.exec(String(rule || ''));
  if (!match) return '';
  return /^https?:\/\//i.test(match[1]) ? match[1] : `http://${match[1]}`;
}

async function officialDependencySet(version, dispatcher) {
  const discovered = new Map();
  const pending = new Map();
  const visit = (packageName) => {
    if (pending.has(packageName)) return pending.get(packageName);
    const task = (async () => {
      const encodedName = encodeURIComponent(packageName).replace('%40', '@');
      const response = await fetch(`https://registry.npmjs.org/${encodedName}/${encodeURIComponent(version)}`, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60000),
        ...(dispatcher ? { dispatcher } : {}),
      });
      if (!response.ok) throw new Error(`${packageName}@${version} 尚未完整发布（HTTP ${response.status}）。`);
      const metadata = await response.json();
      discovered.set(packageName, version);
      const dependencies = Object.keys(metadata.dependencies || {})
        .filter((name) => name.startsWith('@deepseek-ai/dsh-'));
      await Promise.all(dependencies.map(visit));
    })();
    pending.set(packageName, task);
    return task;
  };
  await visit('@deepseek-ai/dsh');
  discovered.delete('@deepseek-ai/dsh');
  return Object.fromEntries([...discovered].sort(([left], [right]) => left.localeCompare(right)));
}

function createHarnessRuntimeManager({ app, resolveProxy = async () => '' }) {
  const appRoot = () => app.getAppPath();
  const settingsPath = () => path.join(app.getPath('userData'), SETTINGS_FILE);
  const runtimeRoot = () => process.env.DSH_TEST_RUNTIME_ROOT
    || path.join(app.getPath('userData'), 'official-harness-runtimes');
  const bundledPackage = () => JSON.parse(fs.readFileSync(path.join(appRoot(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'));
  const bundledVersion = () => bundledPackage().version;
  const readSettings = () => {
    try {
      const value = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
      if (value?.mode === 'installed' && parseVersion(value.version)) return value;
    } catch {}
    return { mode: 'bundled', version: bundledVersion() };
  };
  const runtimeDirectory = (version) => path.join(runtimeRoot(), version);
  const packageDirectory = (version, packageName) => path.join(runtimeDirectory(version), 'node_modules', ...packageName.split('/'));
  const installedEntry = (version) => {
    const base = packageDirectory(version, '@deepseek-ai/dsh');
    return [path.join(base, 'lib', 'bin.js'), path.join(base, 'dist', 'bin.js')].find(fs.existsSync);
  };
  const bundledEntry = () => {
    const base = path.join(appRoot(), 'node_modules', '@deepseek-ai', 'dsh');
    return [path.join(base, 'lib', 'bin.js'), path.join(base, 'dist', 'bin.js')].find(fs.existsSync);
  };
  const active = () => {
    const settings = readSettings();
    const entry = settings.mode === 'installed' ? installedEntry(settings.version) : bundledEntry();
    if (!entry) return { mode: 'bundled', version: bundledVersion(), entry: bundledEntry() };
    return { ...settings, entry };
  };
  const pluginEntry = (packageName, fallbackRelative) => {
    const current = active();
    if (current.mode === 'installed') {
      const external = path.join(packageDirectory(current.version, packageName), 'index.js');
      if (fs.existsSync(external)) return external;
    }
    return path.join(appRoot(), fallbackRelative);
  };
  async function versions() {
    const local = { bundled: bundledVersion(), active: active().version, activeMode: active().mode };
    try {
      const proxy = proxyUrl(await resolveProxy(REGISTRY_URL));
      const response = await fetch(REGISTRY_URL, {
        headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(30000),
        ...(proxy ? { dispatcher: new ProxyAgent(proxy) } : {}),
      });
      if (!response.ok) throw new Error(`官方 npm 版本目录返回 ${response.status}`);
      const registry = await response.json();
      const publishedVersions = Object.keys(registry.versions || {}).filter((value) => parseVersion(value))
        .sort(compareVersions).reverse();
      const available = publishedVersions
        .filter((value) => compareVersions(value, '0.1.1-rc.2') >= 0);
      const taggedVersions = Object.values(registry['dist-tags'] || {}).filter((value) => parseVersion(value));
      const latest = [...taggedVersions, ...publishedVersions].sort(compareVersions).reverse()[0] || local.bundled;
      return {
        ...local,
        latest,
        versions: [...new Set([local.active, local.bundled, ...taggedVersions, ...available])].slice(0, 30),
        allVersions: available,
        publishedVersions: publishedVersions.slice(0, 30),
        distTags: registry['dist-tags'] || {},
        checkedAt: new Date().toISOString(),
        source: REGISTRY_URL,
      };
    } catch (error) {
      return {
        ...local,
        latest: local.bundled,
        versions: [...new Set([local.active, local.bundled])],
        allVersions: [local.active, local.bundled],
        publishedVersions: [],
        distTags: {},
        checkedAt: new Date().toISOString(),
        source: REGISTRY_URL,
        warning: `暂时无法连接官方版本目录：${String(error?.message || error).slice(0, 120)}`,
      };
    }
  }
  async function install(version, onLine = () => {}) {
    const catalog = await versions();
    if (!catalog.allVersions.includes(version) && !catalog.versions.includes(version)) {
      throw new Error('该版本不在 DeepSeek 官方 npm 版本目录中。');
    }
    if (version === bundledVersion()) {
      atomicJson(settingsPath(), { mode: 'bundled', version });
      return { version, mode: 'bundled', restartRequired: true };
    }
    const target = runtimeDirectory(version);
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const fileSpec = (relative) => `file:${path.join(appRoot(), relative).replaceAll('\\', '/')}`;
    const proxy = proxyUrl(await resolveProxy(REGISTRY_URL));
    const officialDependencies = await officialDependencySet(version, proxy ? new ProxyAgent(proxy) : null);
    onLine(`已核对 ${Object.keys(officialDependencies).length + 1} 个 DeepSeek 官方运行包`);
    atomicJson(path.join(target, 'package.json'), {
      name: 'deep-seek-yu-official-harness-runtime',
      private: true,
      dependencies: {
        '@deepseek-ai/cordis-plugin-group': '1.0.1',
        '@deepseek-ai/dsh': version,
        ...officialDependencies,
        '@deep-seek-yu/local-vision': fileSpec('harness-plugins/local-vision'),
        '@deep-seek-yu/desktop-companion': fileSpec('harness-plugins/desktop-companion'),
        '@deep-seek-yu/account-status': fileSpec('harness-plugins/account-status'),
      },
    });
    fs.writeFileSync(path.join(target, 'pnpm-workspace.yaml'),
      "packages:\n  - .\nminimumReleaseAge: 0\nonlyBuiltDependencies:\n  - '@deepseek-ai/dsh-subprocess-local'\n  - '@google/genai'\n  - '@huggingface/transformers'\n  - koffi\n  - node-pty\n  - onnxruntime-node\n  - protobufjs\n  - sharp\n", { mode: 0o600 });
    const pnpm = path.join(appRoot(), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
    if (!fs.existsSync(pnpm)) throw new Error('安装包缺少内置 pnpm，请重新安装客户端。');
    const node = findNodeExecutable(app);
    if (!node) throw new Error('安装包缺少 Harness 私有 Node.js 运行时，请重新安装客户端。');
    const environment = { ...process.env };
    onLine(`正在从 DeepSeek 官方 npm 安装 @deepseek-ai/dsh@${version}`);
    let installWarning = '';
    try {
      await run(node, ['--expose-internals', pnpm, '--dir', target, 'install', '--prod', '--config.node-linker=hoisted',
        '--fetch-timeout=300000', '--fetch-retries=3', '--network-concurrency=8', '--no-optional'], { env: environment }, onLine);
    } catch (error) {
      if (!installedEntry(version)) throw error;
      const message = String(error?.message || error);
      const recoverableOptionalDependencyError = /ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY/.test(message)
        && /(?:darwin|linux|arm64|ia32)/i.test(message);
      if (!recoverableOptionalDependencyError) throw error;
      installWarning = message.slice(-1200);
      onLine('官方 Harness 启动文件已完整下载；忽略 pnpm 对非 Windows 可选依赖的收尾错误。');
    }
    const patcher = path.join(appRoot(), 'scripts', 'apply-harness-core-patches.mjs');
    await run(node, ['--expose-internals', patcher, target, '--best-effort'], { env: environment }, onLine);
    if (!installedEntry(version)) throw new Error('官方 Harness 已下载，但没有找到启动入口。');
    atomicJson(settingsPath(), { mode: 'installed', version });
    return { version, mode: 'installed', restartRequired: true, ...(installWarning ? { warning: installWarning } : {}) };
  }
  return { active, versions, install, pluginEntry, bundledVersion };
}

module.exports = { createHarnessRuntimeManager };
