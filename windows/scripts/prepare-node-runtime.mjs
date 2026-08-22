import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  throw new Error('The Windows installer runtime can only be prepared on Windows.');
}

const major = Number(process.versions.node.split('.')[0]);
if (!Number.isInteger(major) || major < 22) {
  throw new Error(`Node.js 22 or newer is required to package Harness (found ${process.versions.node}).`);
}

const windowsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runtimeDirectory = path.join(windowsRoot, 'runtime');
const destination = path.join(runtimeDirectory, 'node.exe');
await mkdir(runtimeDirectory, { recursive: true });
await copyFile(process.execPath, destination);
const copied = await stat(destination);
if (copied.size < 10_000_000) throw new Error('The copied Node.js runtime is unexpectedly small.');
process.stdout.write(`Prepared private Node.js ${process.versions.node} runtime (${copied.size} bytes).\n`);
