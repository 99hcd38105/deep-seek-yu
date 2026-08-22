const fs = require('node:fs');
const path = require('node:path');

function findNodeExecutable(app) {
  const appRoot = app.getAppPath();
  const unpackedRoot = appRoot.toLowerCase().endsWith('.asar') ? `${appRoot}.unpacked` : appRoot;
  const candidates = [
    path.join(unpackedRoot, 'runtime', 'node.exe'),
    path.join(appRoot, 'runtime', 'node.exe'),
    path.join(process.env.ProgramFiles || '', 'nodejs', 'node.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'nodejs', 'node.exe'),
    path.join(process.env.APPDATA || '', 'npm', 'node.exe'),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate))
    || (app.isPackaged ? null : process.execPath);
}

module.exports = { findNodeExecutable };
