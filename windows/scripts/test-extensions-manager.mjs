import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const {
  addAllowedBuilds, approvalFromFailure, checkPluginUpdate, compareVersions, ensurePnpmShim, installedPlugins, normalizeRegistry,
  recommendedInstallSpec, resolveCompatibleInstall, updatePluginEnabled,
} = require('../extensions-manager');

if (compareVersions('1.2.0', '1.1.9') !== 1 || compareVersions('1.1.2', '1.1.2') !== 0
  || compareVersions('1.1.2-rc.2', '1.1.2') !== -1) throw new Error('Semantic version comparison is incorrect.');
const npmUpdate = await checkPluginUpdate({
  name: '@owner/active', requested: '^1.0.0', version: '1.2.0', installed: true,
}, { fetchJson: async (url) => {
  if (!url.includes('registry.npmjs.org')) throw new Error(`Unexpected npm update URL: ${url}`);
  return { version: '1.3.0' };
} });
if (!npmUpdate.updateAvailable || npmUpdate.latestVersion !== '1.3.0') throw new Error(`npm update was not detected: ${JSON.stringify(npmUpdate)}`);
const githubUpdate = await checkPluginUpdate({
  name: 'github-plugin', requested: 'github:owner/github-plugin', version: '2.0.0', installed: true,
}, { fetchJson: async (url) => {
  if (url.includes('/main/')) return { name: 'github-plugin', version: '2.0.0' };
  throw new Error('not found');
} });
if (githubUpdate.updateAvailable || githubUpdate.latestVersion !== '2.0.0' || githubUpdate.updateSource !== 'GitHub main') {
  throw new Error(`GitHub current version check is incorrect: ${JSON.stringify(githubUpdate)}`);
}

const registry = normalizeRegistry({
  verified: {
    updated: 'test',
    plugins: [
      { name: 'Official', repo: 'owner/official', npm: '@owner/official', category: 'plugin', status: 'verified', official: true, stars: 1 },
      { name: 'Market duplicate', repo: 'owner/market', category: 'plugin', status: 'verified', stars: 5 },
      { name: 'Rejected', repo: 'owner/rejected', category: 'plugin', status: 'rejected', stars: 100 },
      { name: 'Not a plugin', repo: 'owner/skill', category: 'skill', status: 'verified', stars: 100 },
    ],
  },
  market: {
    generatedAt: 'test',
    plugins: [
      { name: 'Market duplicate', fullName: 'owner/market', type: 'cordis-plugin', descriptionZh: '市场描述', stars: 9,
        install: { commands: ['dsh plugin --profile web add @owner/market'] } },
      { name: 'Market only', fullName: 'owner/only', type: 'cordis-plugin',
        install: { commands: ['dsh plugin --profile web add github:owner/only'] } },
    ],
  },
  live: { items: [
    { name: 'market', full_name: 'owner/market', description: 'Live duplicate', topics: ['dsh-plugin'], stargazers_count: 10 },
    { name: 'live', full_name: 'owner/live', description: 'Live only', topics: ['dsh-plugin'], stargazers_count: 2 },
  ] },
});

if (registry.plugins.length !== 4) throw new Error(`Expected 4 merged entries, got ${registry.plugins.length}`);
if (registry.counts.market !== 2 || registry.counts.live !== 2) throw new Error(`Unexpected source counts: ${JSON.stringify(registry.counts)}`);
const duplicate = registry.plugins.find((item) => item.repo === 'owner/market');
if (duplicate.installSpec !== '@owner/market') throw new Error('npm install target should be preferred over the GitHub prepare path.');
if (duplicate.catalogs.length !== 3 || !duplicate.verified) throw new Error('Duplicate catalogs and verification should be merged.');
if (registry.plugins.some((item) => item.name === 'Rejected')) throw new Error('Rejected entries must not be exposed.');
const recommended = recommendedInstallSpec(`
  dsh plugin --profile web add github:owner/monorepo
  dsh plugin --profile web add @owner/web-ui-all@latest
`);
if (recommended !== '@owner/web-ui-all@latest') throw new Error(`Expected npm bundle recommendation, got ${recommended}`);
const compatibilityRequests = [];
const compatibility = await resolveCompatibleInstall({ name: 'monorepo', repo: 'owner/monorepo' }, {
  fetchJson: async (url) => {
    compatibilityRequests.push(url);
    if (url.includes('/dev/package.json')) return { name: 'monorepo', private: true };
    throw new Error('not found');
  },
  fetchText: async (url) => {
    compatibilityRequests.push(url);
    if (url.includes('/dev/README.md')) return 'dsh plugin --profile web add @owner/web-ui-all@latest';
    throw new Error('not found');
  },
});
if (compatibility.spec !== '@owner/web-ui-all@latest' || !compatibility.adapted
  || compatibilityRequests.some((url) => url.includes('api.github.com'))) {
  throw new Error(`Compatibility fallback must work without GitHub API metadata: ${JSON.stringify(compatibility)}`);
}

const gitApproval = approvalFromFailure(
  'ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED\ngit-hosted package "dsh-market@1.0.0" needs to execute build scripts',
  { name: 'dsh-market', repo: 'dsh-market/dsh-market' },
);
if (gitApproval[0] !== 'dsh-market@git+https://github.com/dsh-market/dsh-market.git') {
  throw new Error(`Unexpected git approval key: ${JSON.stringify(gitApproval)}`);
}
const dependencyApprovals = approvalFromFailure('Ignored build scripts: esbuild@0.25.0, @scope/native@2.0.0', {});
if (dependencyApprovals.join(',') !== 'esbuild,@scope/native') throw new Error(`Unexpected dependency approvals: ${dependencyApprovals}`);

const fixture = path.join(tmpdir(), `dsy-extensions-${process.pid}-${Date.now()}`);
try {
  const appRoot = path.join(fixture, 'app');
  const userData = path.join(fixture, 'user-data');
  mkdirSync(path.join(appRoot, 'runtime'), { recursive: true });
  mkdirSync(path.join(appRoot, 'node_modules', 'pnpm', 'bin'), { recursive: true });
  writeFileSync(path.join(appRoot, 'runtime', 'node.exe'), 'fixture');
  writeFileSync(path.join(appRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'), 'fixture');
  const shimDir = ensurePnpmShim({ getAppPath: () => appRoot, getPath: () => userData, isPackaged: true });
  const shim = path.join(shimDir, 'pnpm.cmd');
  if (!existsSync(shim) || !readFileSync(shim, 'utf8').includes('pnpm.cjs')) throw new Error('Private pnpm shim was not created.');

  const profile = path.join(fixture, 'profile');
  mkdirSync(profile, { recursive: true });
  mkdirSync(path.join(profile, 'node_modules', '@owner', 'active'), { recursive: true });
  mkdirSync(path.join(profile, 'node_modules', '@owner', 'disabled'), { recursive: true });
  mkdirSync(path.join(profile, 'node_modules', 'plain-library'), { recursive: true });
  writeFileSync(path.join(profile, 'package.json'), JSON.stringify({
    dependencies: { '@owner/active': '^1.0.0', '@owner/disabled': '^1.0.0', 'plain-library': 'github:owner/monorepo' },
    dsh: { profile: { bundles: ['@owner/active'] } },
  }));
  writeFileSync(path.join(profile, 'node_modules', '@owner', 'active', 'package.json'), JSON.stringify({
    name: '@owner/active', version: '1.2.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  writeFileSync(path.join(profile, 'node_modules', '@owner', 'disabled', 'package.json'), JSON.stringify({
    name: '@owner/disabled', version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }));
  writeFileSync(path.join(profile, 'node_modules', 'plain-library', 'package.json'), JSON.stringify({
    name: 'plain-library', version: '0.1.0', private: true,
  }));
  const installed = installedPlugins(profile);
  if (installed.length !== 3 || installed.find((item) => item.name === '@owner/active')?.status !== 'active'
    || installed.find((item) => item.name === '@owner/disabled')?.status !== 'disabled'
    || installed.find((item) => item.name === 'plain-library')?.status !== 'inactive'
    || !installed.find((item) => item.name === 'plain-library')?.repairable) {
    throw new Error(`Installed plugin activation status is incorrect: ${JSON.stringify(installed)}`);
  }
  updatePluginEnabled(profile, '@owner/active', false);
  updatePluginEnabled(profile, '@owner/disabled', true);
  const toggled = installedPlugins(profile);
  if (toggled.find((item) => item.name === '@owner/active')?.status !== 'disabled'
    || toggled.find((item) => item.name === '@owner/disabled')?.status !== 'active') {
    throw new Error(`Plugin enable/disable state was not persisted: ${JSON.stringify(toggled)}`);
  }
  writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\n');
  addAllowedBuilds(profile, ['dsh-market@git+https://github.com/dsh-market/dsh-market.git', 'esbuild']);
  const yaml = YAML.parse(readFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'utf8'));
  if (!yaml.allowBuilds?.['dsh-market@git+https://github.com/dsh-market/dsh-market.git'] || !yaml.allowBuilds?.esbuild) {
    throw new Error('Explicit allowBuilds values were not saved.');
  }
  if (yaml.nodeLinker !== 'hoisted') throw new Error('Existing workspace settings were not preserved.');
} finally { rmSync(fixture, { recursive: true, force: true }); }

process.stdout.write(`extensions manager test passed: registry, updates, API-independent compatibility, repair metadata, enable/disable state, pnpm shim and build approvals verified\n`);
