const { dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { ProxyAgent } = require('undici');
const { findNodeExecutable } = require('./node-runtime');

const REGISTRY_SOURCES = {
  verified: 'https://raw.githubusercontent.com/dshworks/awesome-dsh-plugins/main/data/plugins.json',
  market: 'https://dsh.market/plugins.json',
  live: 'https://api.github.com/search/repositories?q=topic%3Adsh-plugin+fork%3Afalse+archived%3Afalse&sort=updated&order=desc&per_page=100',
};
const TOPIC_URL = 'https://github.com/topics/dsh-plugin';

function packageName(value) {
  const name = String(value || '').trim();
  return /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name) ? name : '';
}

function npmInstallSpec(value) {
  const spec = String(value || '').trim();
  return /^(@[a-z0-9._-]+\/[a-z0-9._-]+|[a-z0-9._-]+)(?:@(?:[a-z0-9*^~<>=._+-]+))?$/i.test(spec) ? spec : '';
}

function packageNameFromSpec(value) {
  const spec = npmInstallSpec(value);
  if (!spec) return '';
  const separator = spec.startsWith('@') ? spec.lastIndexOf('@') : spec.indexOf('@');
  return packageName(separator > 0 ? spec.slice(0, separator) : spec);
}

function repositoryName(value) {
  const repo = String(value || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git\/?$/, '').replace(/\/$/, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : '';
}

function installSpec(plugin) {
  const npmName = packageName(plugin.npm);
  if (npmName) return npmName;
  const repo = repositoryName(plugin.repo);
  if (!repo) return '';
  const suffix = plugin.path ? `#path:${String(plugin.path).replace(/^\//, '')}` : '';
  return `github:${repo}${suffix}`;
}

function commandInstallSpec(commands) {
  const candidates = [];
  for (const command of Array.isArray(commands) ? commands : []) {
    const source = String(command).trim();
    const match = /\bdsh(?:\.cmd)?\s+plugin\b[^\r\n]*?\badd\s+(?:"([^"]+)"|'([^']+)'|([^\s]+))/i.exec(source);
    const candidate = String(match?.[1] || match?.[2] || match?.[3] || source).replace(/["']+$/, '');
    if (npmInstallSpec(candidate) || /^github:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#path:[^\s]+)?$/i.test(candidate)) candidates.push(candidate);
  }
  return candidates.find((candidate) => npmInstallSpec(candidate)) || candidates[0] || '';
}

function recommendedInstallSpec(readme, installCommands = []) {
  const commands = [...String(readme || '').matchAll(/\bdsh(?:\.cmd)?\s+plugin\s+--profile\s+web\s+add\s+([^\s`"']+)/gi)]
    .map((match) => String(match[1] || '').replace(/[),.;]+$/, ''));
  return commandInstallSpec([...(installCommands || []), ...commands]);
}

function atomicJson(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, filename);
}

function writeTextAtomic(filename, value) {
  const temporary = `${filename}.tmp`;
  fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
  fs.writeFileSync(temporary, value, { mode: 0o600 });
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

function normalizedEntry(item) {
  const repo = repositoryName(item.repo);
  const entry = {
    name: String(item.name || repo.split('/').pop() || '').slice(0, 100),
    repo,
    description: String(item.description || '').slice(0, 500),
    category: item.category || 'plugin',
    npm: packageName(item.npm),
    path: String(item.path || '').replace(/^\//, '').slice(0, 180),
    tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 10) : [],
    stars: Number.isFinite(item.stars) ? item.stars : null,
    verifiedAgainst: String(item.verifiedAgainst || '').slice(0, 80),
    official: Boolean(item.official), featured: Boolean(item.featured),
    status: String(item.status || 'unverified'), verified: Boolean(item.verified),
    catalogs: Array.isArray(item.catalogs) ? item.catalogs : [],
    installCommands: Array.isArray(item.installCommands) ? item.installCommands.map(String).slice(0, 8) : [],
  };
  entry.sourceUrl = `https://github.com/${entry.repo}`;
  entry.installSpec = installSpec(entry);
  return entry;
}

function normalizeVerified(data) {
  const rejectedStatuses = new Set(['rejected', 'invalid', 'malware', 'removed']);
  return (Array.isArray(data?.plugins) ? data.plugins : [])
    .filter((item) => ['plugin', 'bundle'].includes(item.category)
      && !rejectedStatuses.has(String(item.status || '').toLowerCase()))
    .map((item) => normalizedEntry({
      ...item,
      verified: Boolean(item.official || item.status === 'verified'),
      catalogs: ['验证目录'],
    })).filter((item) => item.repo && item.installSpec);
}

function normalizeMarket(data) {
  return (Array.isArray(data?.plugins) ? data.plugins : []).map((item) => {
    const repo = repositoryName(item.fullName || `${item.owner || ''}/${item.repo || ''}`);
    const target = commandInstallSpec(item.install?.commands);
    const npm = packageNameFromSpec(target);
    const github = /^github:([^#]+)(?:#path:(.+))?$/i.exec(target);
    return normalizedEntry({
      name: item.name || repo.split('/').pop(), repo: github?.[1] || repo,
      path: github?.[2] || '', npm,
      description: item.descriptionZh || item.description || item.readmeSummary,
      category: item.type === 'cordis-plugin' ? 'plugin' : item.type,
      tags: item.tags || item.topics, stars: item.stars,
      featured: Boolean(item.curated), verified: item.verdict === 'pass',
      status: item.verdict === 'pass' ? 'verified' : item.curated ? 'curated' : 'unverified',
      catalogs: ['DSH Market'],
      installCommands: item.install?.commands,
    });
  }).filter((item) => item.category === 'plugin' && item.repo && item.installSpec);
}

function normalizeLive(data) {
  return (Array.isArray(data?.items) ? data.items : []).map((item) => normalizedEntry({
    name: item.name, repo: item.full_name,
    description: item.description || 'GitHub dsh-plugin Topic 中新发现的仓库，尚未经过目录验证。',
    category: 'plugin', tags: item.topics, stars: item.stargazers_count,
    status: 'live-discovery', verified: false, catalogs: ['GitHub Topic 实时发现'],
  })).filter((item) => item.repo && item.installSpec);
}

function mergeEntries(groups) {
  const merged = new Map();
  for (const item of groups.flat()) {
    const key = `${item.repo.toLowerCase()}#${item.path.toLowerCase()}`;
    const existing = merged.get(key);
    if (!existing) { merged.set(key, item); continue; }
    const next = { ...existing };
    if (!next.npm && item.npm) {
      next.npm = item.npm;
      next.name = item.name || next.name;
    }
    if ((!next.description || item.catalogs.includes('DSH Market')) && item.description) next.description = item.description;
    next.stars = Math.max(next.stars || 0, item.stars || 0) || null;
    next.official = next.official || item.official;
    next.featured = next.featured || item.featured;
    next.verified = next.verified || item.verified;
    if (next.verified) next.status = 'verified';
    next.tags = [...new Set([...next.tags, ...item.tags])].slice(0, 10);
    next.catalogs = [...new Set([...next.catalogs, ...item.catalogs])];
    next.installCommands = [...new Set([...(next.installCommands || []), ...(item.installCommands || [])])].slice(0, 8);
    next.installSpec = installSpec(next);
    merged.set(key, next);
  }
  return [...merged.values()].sort((a, b) => Number(b.official) - Number(a.official)
    || Number(b.verified) - Number(a.verified)
    || Number(b.featured) - Number(a.featured)
    || (b.stars || 0) - (a.stars || 0));
}

function normalizeRegistry(data, warning = '') {
  const bundle = data?.verified || data?.market || data?.live ? data : { verified: data };
  const plugins = mergeEntries([normalizeVerified(bundle.verified), normalizeMarket(bundle.market), normalizeLive(bundle.live)]);
  return {
    updated: bundle.market?.generatedAt || bundle.verified?.updated || '',
    source: Object.values(REGISTRY_SOURCES), warning,
    notice: '聚合验证目录、DSH Market 和 GitHub dsh-plugin Topic，均非 DeepSeek 官方认可。安装第三方插件等同于运行其代码。',
    counts: {
      total: plugins.length,
      verified: plugins.filter((item) => item.verified).length,
      market: plugins.filter((item) => item.catalogs.includes('DSH Market')).length,
      live: plugins.filter((item) => item.catalogs.includes('GitHub Topic 实时发现')).length,
    },
    plugins,
  };
}

function decodeOutput(buffer) {
  if (!buffer.length) return '';
  const utf8 = buffer.toString('utf8');
  const replacements = (utf8.match(/�/g) || []).length;
  if (replacements < 2) return utf8;
  try {
    const local = new TextDecoder('gb18030').decode(buffer);
    return (local.match(/�/g) || []).length < replacements ? local : utf8;
  } catch { return utf8; }
}

function cleanProcessError(value) {
  const text = String(value || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '').trim();
  if (/ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED/i.test(text)) {
    return `插件包含安装时构建脚本，pnpm 已按安全策略阻止执行。\n${text.split('\n').filter((line) => /ERR_PNPM|git-hosted package|allowBuilds/i.test(line)).slice(-4).join('\n')}`.slice(0, 1500);
  }
  if (/ERR_PNPM_IGNORED_BUILDS|Ignored build scripts/i.test(text)) {
    return `插件依赖包含被 pnpm 阻止的构建脚本。\n${text.split('\n').filter((line) => /ERR_PNPM|Ignored build scripts|approve-builds/i.test(line)).slice(-4).join('\n')}`.slice(0, 1500);
  }
  if (/['"]pnpm['"].*(not recognized|不是内部或外部命令)/i.test(text)) {
    return '客户端缺少 pnpm 插件管理组件。请升级或重新安装 DeepSeek yu 1.1.1。';
  }
  const lines = text.split('\n').filter(Boolean);
  return lines.slice(-10).join('\n').slice(0, 1500) || '插件安装失败。';
}

function runDsh(app, entry, args, environment) {
  return new Promise((resolve, reject) => {
    const node = findNodeExecutable(app);
    if (!node) return reject(new Error('安装包缺少 Harness 私有 Node.js 运行时，请重新安装客户端。'));
    const child = spawn(node, ['--expose-internals', entry, ...args], {
      env: { ...process.env, ...environment }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = Buffer.alloc(0);
    const receive = (data) => { tail = Buffer.concat([tail, data]).subarray(-128000); };
    child.stdout.on('data', receive);
    child.stderr.on('data', receive);
    child.once('error', reject);
    child.once('exit', (code) => {
      const output = decodeOutput(tail);
      if (code === 0) resolve(output); else reject(new Error(cleanProcessError(output || `插件安装退出代码 ${code}`)));
    });
  });
}

function ensurePnpmShim(app) {
  const node = findNodeExecutable(app);
  const pnpm = path.join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.cjs');
  if (!node || !fs.existsSync(pnpm)) throw new Error('安装包缺少 pnpm 插件管理组件，请重新安装客户端。');
  const directory = path.join(app.getPath('userData'), 'runtime-bin');
  const filename = path.join(directory, 'pnpm.cmd');
  const content = `@echo off\r\n"${node}" "${pnpm}" %*\r\n`;
  if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== content) writeTextAtomic(filename, content);
  return directory;
}

function addAllowedBuilds(profileDir, keys) {
  const filename = path.join(profileDir, 'pnpm-workspace.yaml');
  const source = fs.existsSync(filename) ? fs.readFileSync(filename, 'utf8') : 'packages:\n  - .\n\n';
  const document = YAML.parseDocument(source);
  if (!YAML.isMap(document.get('allowBuilds', true))) document.set('allowBuilds', document.createNode({}));
  for (const key of keys) document.setIn(['allowBuilds', key], true);
  writeTextAtomic(filename, String(document));
}

function versionlessPackage(value) {
  const text = String(value || '').trim();
  const separator = text.startsWith('@') ? text.lastIndexOf('@') : text.indexOf('@');
  return packageName(separator > 0 ? text.slice(0, separator) : text);
}

function approvalFromFailure(message, plugin) {
  const text = String(message || '');
  const keys = [];
  const gitFailure = /ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED|git-hosted package.+needs to execute build scripts/is.test(text);
  if (gitFailure) {
    const described = /git-hosted package\s+"([^"]+)"/i.exec(text)?.[1];
    const name = versionlessPackage(described) || packageName(plugin.packageName) || packageName(plugin.name);
    const repo = repositoryName(plugin.repo);
    if (name && repo) keys.push(`${name}@git+https://github.com/${repo}.git`);
  }
  const ignored = /Ignored build scripts:\s*([^\r\n]+)/i.exec(text)?.[1] || '';
  for (const candidate of ignored.split(',').map(versionlessPackage).filter(Boolean)) keys.push(candidate);
  return [...new Set(keys)].filter((key) => /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:@git\+https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.git)?$/i.test(key));
}

function installedPlugins(profileDir) {
  const profile = readJson(path.join(profileDir, 'package.json')) || {};
  const dependencies = profile.dependencies || {};
  const bundles = new Set(profile.dsh?.profile?.bundles || []);
  return Object.entries(dependencies).map(([name, requested]) => {
    const manifest = readJson(path.join(profileDir, 'node_modules', ...name.split('/'), 'package.json')) || {};
    const bundle = Boolean(manifest.dsh?.bundle?.patch && bundles.has(name));
    const repository = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url;
    return {
      name, requested: String(requested), version: String(manifest.version || ''),
      bundle, installed: Boolean(manifest.name),
      status: !manifest.name ? 'missing' : bundle ? 'active' : 'inactive',
      description: String(manifest.description || ''),
      sourceUrl: String(manifest.homepage || repository || '').replace(/^git\+/, '').replace(/\.git$/, ''),
    };
  }).sort((left, right) => Number(right.bundle) - Number(left.bundle) || left.name.localeCompare(right.name));
}

function createExtensionsManager({ app, mainWindow, runtimeManager, dshHome, onRestartRequired }) {
  let operation = null;
  const cachePath = path.join(app.getPath('userData'), 'community-plugins-cache.json');

  async function fetchResource(url, timeout = 60000, format = 'json') {
    const rule = await mainWindow.webContents.session.resolveProxy(url);
    const proxy = proxyUrl(rule);
    const dispatcher = proxy ? new ProxyAgent(proxy) : null;
    try {
      const response = await fetch(url, {
        headers: { Accept: 'application/json, text/plain;q=0.9', 'User-Agent': 'DeepSeek-yu-plugin-discovery' },
        signal: AbortSignal.timeout(timeout), ...(dispatcher ? { dispatcher } : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return format === 'text' ? response.text() : response.json();
    } finally { if (dispatcher) await dispatcher.close(); }
  }

  async function fetchJson(url, timeout = 60000) {
    return fetchResource(url, timeout, 'json');
  }

  async function fetchText(url, timeout = 60000) {
    return fetchResource(url, timeout, 'text');
  }

  async function compatibleInstall(plugin) {
    const original = installSpec(plugin || {});
    if (!original || plugin.npm) return { spec: original, packageName: packageName(plugin.npm), adapted: false };
    const repo = repositoryName(plugin.repo);
    if (!repo) return { spec: original, packageName: '', adapted: false };
    try {
      const metadata = await fetchJson(`https://api.github.com/repos/${repo}`, 30000);
      const branch = encodeURIComponent(String(metadata.default_branch || 'main'));
      const [manifestResult, readmeResult] = await Promise.allSettled([
        fetchJson(`https://raw.githubusercontent.com/${repo}/${branch}/package.json`, 30000),
        fetchText(`https://raw.githubusercontent.com/${repo}/${branch}/README.md`, 30000),
      ]);
      const manifest = manifestResult.status === 'fulfilled' ? manifestResult.value : {};
      if (manifest.dsh?.bundle?.patch) {
        return { spec: original, packageName: packageName(manifest.name), adapted: false };
      }
      const readme = readmeResult.status === 'fulfilled' ? readmeResult.value : '';
      const declared = recommendedInstallSpec(readme, plugin.installCommands);
      if (declared && declared !== original) {
        return {
          spec: declared, packageName: packageNameFromSpec(declared), adapted: true,
          reason: `仓库根包${manifest.private ? '是私有工作区' : '没有声明 dsh.bundle'}，已按仓库 README 改用可挂载插件`,
        };
      }
      return { spec: original, packageName: packageName(manifest.name), adapted: false };
    } catch {
      return { spec: original, packageName: '', adapted: false };
    }
  }

  function pluginEnvironment() {
    const shimPath = ensurePnpmShim(app);
    return {
      DSH_HOME: dshHome(), PNPM_HOME: shimPath,
      PATH: `${shimPath}${path.delimiter}${process.env.PATH || ''}`,
      CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1', LANG: 'en_US.UTF-8',
    };
  }

  async function registry() {
    const cachedRaw = readJson(cachePath);
    const cached = cachedRaw?.verified || cachedRaw?.market || cachedRaw?.live ? cachedRaw : { verified: cachedRaw };
    const names = Object.keys(REGISTRY_SOURCES);
    const results = await Promise.allSettled(names.map(async (name) => [name, await fetchJson(REGISTRY_SOURCES[name], name === 'market' ? 90000 : 60000)]));
    const bundle = {};
    const warnings = [];
    for (let index = 0; index < results.length; index += 1) {
      const name = names[index];
      const result = results[index];
      if (result.status === 'fulfilled') bundle[result.value[0]] = result.value[1];
      else if (cached?.[name]) { bundle[name] = cached[name]; warnings.push(`${name} 使用缓存`); }
      else warnings.push(`${name} 暂不可用`);
    }
    if (!bundle.verified && !bundle.market && !bundle.live) throw new Error('所有社区插件目录暂时都无法访问。');
    atomicJson(cachePath, bundle);
    return normalizeRegistry(bundle, warnings.join(' · '));
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
    const compatible = await compatibleInstall(plugin || {});
    const spec = compatible.spec;
    if (!spec) throw new Error('插件安装来源无效。');
    const sourceUrl = `https://github.com/${plugin.repo}`;
    const verification = plugin.official ? '官方目录条目'
      : plugin.verified ? '社区目录已验证' : `未验证条目（状态：${plugin.status || 'unverified'}）`;
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: '安装第三方 Harness 插件', message: `确认安装 ${plugin.name || spec}？`,
      detail: `来源：${sourceUrl}\n安装项：${spec}${compatible.adapted ? `\n兼容适配：${compatible.reason}` : ''}\n收录目录：${(plugin.catalogs || []).join('、') || '社区发现'}\n目录状态：${verification}\n\n第三方插件可以访问 Harness 的文件、命令和网络能力。请先查看源码；未验证条目风险更高。`,
      buttons: ['取消', '查看源码', '我已了解，安装'], defaultId: 0, cancelId: 0,
    });
    if (choice.response === 1) { await shell.openExternal(sourceUrl); return { canceled: true }; }
    if (choice.response !== 2) return { canceled: true };

    const active = runtimeManager.active();
    const profileDir = path.join(dshHome(), 'profiles', 'web');
    const before = installedPlugins(profileDir);
    const environment = pluginEnvironment();
    const execute = () => runDsh(app, active.entry,
      ['plugin', '--profile', 'web', 'add', spec, '--reporter=append-only'], environment);
    operation = execute();
    try {
      try { await operation; }
      catch (error) {
        const approvals = approvalFromFailure(error.message, plugin);
        if (!approvals.length) throw error;
        const approval = await dialog.showMessageBox(mainWindow, {
          type: 'warning', title: '允许此插件运行构建脚本？',
          message: `${plugin.name || spec} 需要在安装时运行构建脚本`,
          detail: `pnpm 默认阻止第三方构建脚本。只有你确认后，DeepSeek yu 才会仅为以下包写入 allowBuilds 并自动重试：\n\n${approvals.join('\n')}\n\n构建脚本在 Harness 沙箱外运行，请先查看源码。`,
          buttons: ['取消安装', '查看源码', '仅允许这些包并重试'], defaultId: 0, cancelId: 0,
        });
        if (approval.response === 1) { await shell.openExternal(sourceUrl); return { canceled: true }; }
        if (approval.response !== 2) return { canceled: true };
        addAllowedBuilds(profileDir, approvals);
        operation = execute();
        await operation;
      }
      const after = installedPlugins(profileDir);
      const added = after.filter((item) => !before.some((previous) => previous.name === item.name));
      const installed = after.find((item) => item.name === compatible.packageName) || added[0];
      if (!installed?.bundle) {
        return {
          ok: true, restartRequired: false, active: false,
          warning: installed
            ? `${installed.name} 已下载，但它没有向 Harness 声明可挂载的 dsh.bundle，因此不会改变界面或提供工具。可以在“已安装插件”中卸载。`
            : '依赖下载完成，但没有检测到可挂载的 Harness bundle。请在“已安装插件”中查看状态。',
        };
      }
      onRestartRequired();
      return { ok: true, restartRequired: true, active: true, packageName: installed.name, adapted: compatible.adapted };
    } finally { operation = null; }
  }

  async function removePlugin(name) {
    if (operation) throw new Error('已有操作正在进行。');
    const profileDir = path.join(dshHome(), 'profiles', 'web');
    const installed = installedPlugins(profileDir);
    const plugin = installed.find((item) => item.name === name);
    if (!plugin) throw new Error('该插件不在当前 web profile 中。');
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning', title: '卸载 Harness 插件', message: `确认卸载 ${plugin.name}？`,
      detail: `${plugin.bundle ? '该插件当前已挂载，卸载后需要重启客户端。' : '该依赖没有成功挂载，可以安全从 profile 中移除。'}\n\n卸载只删除插件包和它在 profile 中的挂载，不删除工作区、会话或 DeepSeek API Key。`,
      buttons: ['取消', '卸载'], defaultId: 0, cancelId: 0,
    });
    if (choice.response !== 1) return { canceled: true };
    const active = runtimeManager.active();
    operation = runDsh(app, active.entry,
      ['plugin', '--profile', 'web', 'remove', plugin.name, '--reporter=append-only'], pluginEnvironment());
    try {
      await operation;
      if (plugin.bundle) onRestartRequired();
      return { ok: true, restartRequired: plugin.bundle };
    } finally { operation = null; }
  }

  async function dispatch(action) {
    switch (action?.type) {
      case 'extensions:versions': return runtimeManager.versions();
      case 'extensions:registry': return registry();
      case 'extensions:installed': return { plugins: installedPlugins(path.join(dshHome(), 'profiles', 'web')) };
      case 'extensions:install-runtime': return installRuntime(String(action.payload?.version || ''));
      case 'extensions:install-plugin': return installPlugin(action.payload?.plugin || {});
      case 'extensions:remove-plugin': return removePlugin(String(action.payload?.name || ''));
      case 'extensions:open-source': {
        const url = String(action.payload?.url || '');
        if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/i.test(url)) throw new Error('只允许打开 GitHub 插件仓库源码。');
        await shell.openExternal(url);
        return { ok: true };
      }
      case 'extensions:open-topic':
        await shell.openExternal(TOPIC_URL);
        return { ok: true };
      default: throw new Error('未知的 DeepSeek yu 插件操作。');
    }
  }

  return { dispatch, destroy() {} };
}

module.exports = {
  addAllowedBuilds, approvalFromFailure, createExtensionsManager, ensurePnpmShim,
  installSpec, installedPlugins, normalizeRegistry, normalizeLive, normalizeMarket, normalizeVerified,
  recommendedInstallSpec,
};
