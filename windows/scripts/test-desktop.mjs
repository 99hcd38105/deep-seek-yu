import { _electron as electron } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testUserData = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-test-'));
const testModelCache = process.env.DSH_TEST_MODEL_CACHE
  || path.join(process.env.APPDATA || os.homedir(), 'deepseek-harness-desktop', 'models');
await mkdir(path.join(testUserData, 'dsh-home'), { recursive: true });
await writeFile(
  path.join(testUserData, 'dsh-home', '.credentials.yaml'),
  'DEEPSEEK_API_KEY: "test-key-not-used"\n',
);
const application = process.env.DSH_TEST_EXECUTABLE
  ? await electron.launch({
      executablePath: process.env.DSH_TEST_EXECUTABLE,
      env: {
        ...process.env,
        DSH_TEST_USER_DATA: testUserData,
        DSH_TEST_MODEL_CACHE: testModelCache,
      },
    })
  : await electron.launch({
      args: ['.'],
      env: {
        ...process.env,
        DSH_TEST_USER_DATA: testUserData,
        DSH_TEST_MODEL_CACHE: testModelCache,
      },
    });
try {
  await application.firstWindow();
  const mainWindow = await (async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const candidate = application.windows().find((window) => window.url().startsWith('http://127.0.0.1:'));
      if (candidate) return candidate;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`Harness main window did not appear: ${JSON.stringify(application.windows().map((window) => window.url()))}`);
  })();
  await mainWindow.waitForLoadState('domcontentloaded');
  try {
    await mainWindow.waitForFunction(() => window.__dshDesktopPetBridgeInstalled === true, null, { timeout: 45000 });
  } catch (error) {
    const diagnostics = await mainWindow.evaluate(async () => ({
      url: location.href,
      title: document.title,
      body: document.body?.innerText?.slice(0, 1000),
      desktopCompanionStatus: await fetch('/deep-seek-yu/desktop-companion.js').then(response => response.status).catch(() => 0),
      accountStatus: await fetch('/deep-seek-yu/account-status.js').then(response => response.status).catch(() => 0),
    }));
    throw new Error(`Harness plugins did not initialize: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
  await mainWindow.locator('#deep-seek-yu-account-status').waitFor({ timeout: 30000 });
  await mainWindow.getByText('deep seek yu', { exact: true }).first().waitFor({ timeout: 30000 });
  if ((await mainWindow.title()).trim() !== 'deep seek yu') {
    throw new Error(`Unexpected main window title: ${await mainWindow.title()}`);
  }
  await application.evaluate(({ Menu }) => {
    const desktopPetMenu = Menu.getApplicationMenu().items.find((item) => item.label === '桌宠');
    desktopPetMenu.submenu.items.find((item) => item.label === '桌宠设置').click();
  });
  const settingsWindow = await application.waitForEvent('window', { timeout: 15000 });
  await settingsWindow.waitForSelector('#visionState');
  const version = await settingsWindow.locator('.beta').textContent();
  if (version?.trim() !== 'v1.1.0 正式版') throw new Error(`Unexpected settings version: ${version}`);
  await settingsWindow.locator('#prepareVision').click();
  await settingsWindow.locator('#visionState').filter({ hasText: '已就绪' }).waitFor({ timeout: 90000 });
  await application.evaluate(({ Menu }) => {
    const clientMenu = Menu.getApplicationMenu().items.find((item) => item.label === '客户端');
    clientMenu.submenu.items.find((item) => item.label === '官方更新与插件市场').click();
  });
  const extensionsWindow = await application.waitForEvent('window', { timeout: 15000 });
  await extensionsWindow.locator('#version-summary').filter({ hasText: '0.1.1-rc.2' }).waitFor({ timeout: 45000 });
  await extensionsWindow.getByText('第三方插件市场', { exact: true }).waitFor();
  await extensionsWindow.close();
  if (process.argv[2]) await settingsWindow.screenshot({ path: process.argv[2] });
  if (process.env.DSH_TEST_IMAGE) {
    const description = await application.evaluate(async ({ app }, imagePath) => {
      const path = process.getBuiltinModule('node:path');
      const fs = process.getBuiltinModule('node:fs');
      const { createRequire } = process.getBuiltinModule('node:module');
      const require = createRequire(path.join(app.getAppPath(), 'main.js'));
      const { createLocalVision } = require('./local-vision');
      const vision = createLocalVision({
        cacheDir: path.join(app.getPath('userData'), 'models'),
        resolveProxy: (url) => require('electron').session.defaultSession.resolveProxy(url),
      });
      const extension = path.extname(imagePath).toLowerCase();
      const mimeType = extension === '.webp' ? 'image/webp' : extension === '.png' ? 'image/png' : 'image/jpeg';
      return vision.analyze(fs.readFileSync(imagePath), mimeType);
    }, process.env.DSH_TEST_IMAGE);
    if (!description) throw new Error('Packaged local vision returned no description.');
    process.stdout.write(`packaged vision: ${description}\n`);
  }
  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && !window.webContents.isDestroyed()
      && window.webContents.getURL().startsWith('http://127.0.0.1:'))?.close();
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const background = await application.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const main = windows.find((window) => !window.isDestroyed() && !window.webContents.isDestroyed()
      && window.webContents.getURL().startsWith('http://127.0.0.1:'));
    const pet = windows.find((window) => !window.isDestroyed() && window.getTitle() === 'deep seek yu 桌宠');
    return { mainVisible: main?.isVisible(), petVisible: pet?.isVisible() };
  });
  if (background.mainVisible !== false || background.petVisible !== true) {
    throw new Error(`Background close behavior failed: ${JSON.stringify(background)}`);
  }
  process.stdout.write(`desktop test passed: ${JSON.stringify(background)}\n`);
} finally {
  await application.close();
  await rm(testUserData, { recursive: true, force: true });
}
