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
  const mainWindow = await application.firstWindow();
  await mainWindow.waitForLoadState('domcontentloaded');
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
  if (version?.trim() !== 'v1.1.0 测试3版') throw new Error(`Unexpected settings version: ${version}`);
  await settingsWindow.locator('#prepareVision').click();
  await settingsWindow.locator('#visionState').filter({ hasText: '已就绪' }).waitFor({ timeout: 90000 });
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
    BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith('http://127.0.0.1:'))?.close();
  });
  await new Promise((resolve) => setTimeout(resolve, 800));
  const background = await application.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows();
    const main = windows.find((window) => window.webContents.getURL().startsWith('http://127.0.0.1:'));
    const pet = windows.find((window) => window.getTitle() === 'deep seek yu 桌宠');
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
