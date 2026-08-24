import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { pricingPeriodAt } from '../harness-plugins/account-status/index.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const assetDirectory = path.join(root, 'assets', 'pets', 'default-maid');
const manifest = JSON.parse(fs.readFileSync(path.join(assetDirectory, 'pet.json'), 'utf8'));
const requiredActions = ['idle', 'thinking', 'executing', 'success', 'error', 'dragging', 'feeding', 'levelup', 'playing', 'sleeping'];

for (const action of requiredActions) {
  assert.ok(manifest.actions[action], `missing action ${action}`);
  const filename = path.join(assetDirectory, manifest.actions[action]);
  assert.ok(fs.existsSync(filename), `missing asset ${filename}`);
  const metadata = await sharp(filename).metadata();
  assert.equal(metadata.format, 'png', `${action} must be PNG`);
  assert.equal(metadata.hasAlpha, true, `${action} must have transparent alpha`);
  const stats = await sharp(filename).stats();
  assert.ok(stats.channels[3].min === 0 && stats.channels[3].max === 255, `${action} must contain both transparent and visible pixels`);
}

assert.equal(pricingPeriodAt(new Date('2026-08-24T02:00:00.000Z')).period, 'peak', 'Monday 10:00 Beijing should be peak');
assert.equal(pricingPeriodAt(new Date('2026-08-24T04:00:00.000Z')).period, 'off-peak', 'Monday 12:00 Beijing should be off-peak');
assert.equal(pricingPeriodAt(new Date('2026-08-24T06:00:00.000Z')).period, 'peak', 'Monday 14:00 Beijing should be peak');
assert.equal(pricingPeriodAt(new Date('2026-08-22T02:00:00.000Z')).period, 'off-peak', 'Saturday should be off-peak');

const manager = fs.readFileSync(path.join(root, 'pet-manager.js'), 'utf8');
const windowHtml = fs.readFileSync(path.join(root, 'pet-window.html'), 'utf8');
assert.match(manager, /shell\.trashItem\(filename\)/, 'dropped files must use the recoverable Windows trash API');
assert.match(manager, /吃掉并移到回收站/, 'file deletion must require explicit confirmation');
assert.match(manager, /isFile\(\)/, 'folders must not be accepted');
assert.match(windowHtml, /desktopPet\.dragStart/, 'manual drag action must be connected');
assert.match(windowHtml, /desktopPet\.eatDroppedFiles/, 'file-drop feeding must be connected');
assert.match(windowHtml, /@keyframes breathe/, 'dynamic idle animation must be present');

console.log('Desktop pet actions, growth wiring, file safety, and peak schedule passed.');
