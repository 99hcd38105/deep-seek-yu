import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import YAML from 'yaml';

const require = createRequire(import.meta.url);
const {
  addAllowedBuilds, approvalFromFailure, ensurePnpmShim, normalizeRegistry,
} = require('../extensions-manager');

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
  writeFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\nnodeLinker: hoisted\n');
  addAllowedBuilds(profile, ['dsh-market@git+https://github.com/dsh-market/dsh-market.git', 'esbuild']);
  const yaml = YAML.parse(readFileSync(path.join(profile, 'pnpm-workspace.yaml'), 'utf8'));
  if (!yaml.allowBuilds?.['dsh-market@git+https://github.com/dsh-market/dsh-market.git'] || !yaml.allowBuilds?.esbuild) {
    throw new Error('Explicit allowBuilds values were not saved.');
  }
  if (yaml.nodeLinker !== 'hoisted') throw new Error('Existing workspace settings were not preserved.');
} finally { rmSync(fixture, { recursive: true, force: true }); }

process.stdout.write(`extensions manager test passed: ${registry.plugins.length} merged entries, pnpm shim and build approvals verified\n`);
