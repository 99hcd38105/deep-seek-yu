import fs from 'node:fs';
import path from 'node:path';
import visionModule from '../local-vision.js';

const imagePath = process.argv[2];
if (!imagePath) throw new Error('Usage: node scripts/test-local-vision.mjs <image>');
const cacheDir = process.argv[3] || path.resolve('.test-model-cache');

const extension = path.extname(imagePath).toLowerCase();
const mimeType = extension === '.webp' ? 'image/webp' : extension === '.png' ? 'image/png' : 'image/jpeg';
const vision = visionModule.createLocalVision({
  cacheDir,
  resolveProxy: async () => 'PROXY 127.0.0.1:7877; DIRECT',
  onState: (state) => {
    if (state.status === 'downloading') process.stdout.write(`download ${state.progress}%\r`);
  },
});

const description = await vision.analyze(fs.readFileSync(imagePath), mimeType);
process.stdout.write(`\n${description}\n`);
