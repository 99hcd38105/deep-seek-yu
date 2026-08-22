import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { normalizeRegistry } = require('../extensions-manager');

const source = {
  updated: 'test',
  plugins: [
    { name: 'Official', repo: 'owner/official', category: 'plugin', status: 'verified', official: true, stars: 1 },
    { name: 'Verified', repo: 'owner/verified', category: 'bundle', status: 'verified', stars: 5 },
    { name: 'Candidate', repo: 'owner/candidate', category: 'plugin', status: 'candidate', stars: 20 },
    { name: 'Rejected', repo: 'owner/rejected', category: 'plugin', status: 'rejected', stars: 100 },
    { name: 'Not a plugin', repo: 'owner/skill', category: 'skill', status: 'verified', stars: 100 },
  ],
};

const result = normalizeRegistry(source);
if (result.plugins.length !== 3) throw new Error(`Expected 3 installable entries, got ${result.plugins.length}`);
if (result.plugins[0].name !== 'Official' || !result.plugins[0].official || !result.plugins[0].verified) {
  throw new Error('Official entries should be included and prioritized.');
}
if (!result.plugins.some((item) => item.name === 'Candidate' && item.verified === false)) {
  throw new Error('Installable unverified entries should stay searchable and be marked unverified.');
}
if (result.plugins.some((item) => item.name === 'Rejected')) throw new Error('Rejected entries must not be exposed.');

process.stdout.write(`extensions manager test passed: ${result.plugins.map((item) => item.name).join(', ')}\n`);
