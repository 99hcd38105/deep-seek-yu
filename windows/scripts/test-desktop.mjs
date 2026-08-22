import { _electron as electron } from 'playwright';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testUserData = await mkdtemp(path.join(os.tmpdir(), 'dsh-desktop-test-'));
const testModelCache = process.env.DSH_TEST_MODEL_CACHE
  || path.join(process.env.APPDATA || os.homedir(), 'deepseek-harness-desktop', 'models');
await mkdir(path.join(testUserData, 'dsh-home'), { recursive: true });
await writeFile(path.join(testUserData, 'dsh-home', '.credentials.yaml'),
  'version: 1\nrefs:\n  DEEPSEEK_API_KEY: "older-test-key"\nDEEPSEEK_API_KEY: "test-key-not-used"\n');

const launchOptions = {
  env: { ...process.env, DSH_TEST_USER_DATA: testUserData, DSH_TEST_MODEL_CACHE: testModelCache },
};
const application = process.env.DSH_TEST_EXECUTABLE
  ? await electron.launch({ ...launchOptions, executablePath: process.env.DSH_TEST_EXECUTABLE })
  : await electron.launch({ ...launchOptions, args: ['.'] });

try {
  await application.firstWindow({ timeout: 120000 });
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

  const migratedCredentials = await readFile(path.join(testUserData, 'dsh-home', '.credentials.yaml'), 'utf8');
  if (/^DEEPSEEK_API_KEY\s*:/m.test(migratedCredentials)
    || !/^\s{2}DEEPSEEK_API_KEY\s*:/m.test(migratedCredentials)) {
    throw new Error('Legacy DeepSeek credential layout was not migrated.');
  }

  try {
    await mainWindow.waitForFunction(() => window.__dshDesktopPetBridgeInstalled === true, null, { timeout: 45000 });
  } catch (error) {
    const diagnostics = await mainWindow.evaluate(async () => ({
      url: location.href, title: document.title, body: document.body?.innerText?.slice(0, 1000),
      desktopCompanionStatus: await fetch('/deep-seek-yu/desktop-companion.js').then((response) => response.status).catch(() => 0),
      accountApiStatus: await fetch('/deep-seek-yu/api/account-status').then((response) => response.status).catch(() => 0),
    }));
    throw new Error(`Harness plugins did not initialize: ${JSON.stringify(diagnostics)}`, { cause: error });
  }

  await mainWindow.getByText('DeepSeek yu', { exact: true }).first().waitFor({ timeout: 30000 });
  if ((await mainWindow.title()).trim() !== 'DeepSeek yu') throw new Error(`Unexpected main window title: ${await mainWindow.title()}`);
  const topMenuLabels = await application.evaluate(({ Menu }) => Menu.getApplicationMenu().items.map((item) => item.label));
  if (topMenuLabels.includes('桌宠')) throw new Error('顶部菜单不应再显示桌宠入口。');
  if (await mainWindow.locator('#deep-seek-yu-account-status').count()) throw new Error('Legacy floating account button is still present.');

  const onboardingContinue = mainWindow.getByRole('button', { name: '继续', exact: true });
  if (await onboardingContinue.isVisible().catch(() => false)) {
    await onboardingContinue.click();
    await onboardingContinue.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
  }
  await mainWindow.getByRole('button', { name: '设置', exact: true }).click({ force: true });
  const settings = mainWindow.getByRole('dialog').filter({ hasText: '通用设置' }).last();
  await settings.waitFor({ timeout: 30000 });
  const pluginsNavigation = settings.getByText('插件', { exact: true }).first();
  await pluginsNavigation.waitFor({ timeout: 30000 });
  await pluginsNavigation.click({ force: true });
  const pluginTab = settings.getByRole('tab', { name: 'DeepSeek yu' });
  await pluginTab.waitFor({ timeout: 15000 });
  await pluginTab.click();
  const pluginPanel = settings.locator('#deep-seek-yu-plugin-panel');
  await pluginPanel.getByText('桌宠', { exact: true }).waitFor();
  await pluginPanel.getByText('余额与服务状态', { exact: true }).waitFor();
  await pluginPanel.getByText('官方 Harness 更新', { exact: true }).waitFor();
  await pluginPanel.getByText('社区插件市场', { exact: true }).waitFor();
  await pluginPanel.locator('[data-pet-state]').filter({ hasNotText: '正在读取' }).waitFor({ timeout: 15000 });
  await pluginPanel.locator('[data-runtime-state]').filter({ hasText: '0.1.1-rc.2' }).waitFor({ timeout: 45000 });
  await pluginPanel.locator('[data-pet="size"]').fill('180');
  await pluginPanel.locator('[data-save-pet]').click();
  await pluginPanel.locator('[data-pet-state]').filter({ hasText: '已保存' }).waitFor({ timeout: 15000 });

  const timeoutPatch = await application.evaluate(({ app }) => {
    const fs = process.getBuiltinModule('node:fs');
    const path = process.getBuiltinModule('node:path');
    const filename = path.join(app.getAppPath(), 'node_modules', '@deepseek-ai', 'dsh-client-ui-model-selection', 'lib', 'client.js');
    const source = fs.readFileSync(filename, 'utf8');
    return source.includes('deep-seek-yu-model-selection-timeout-v1')
      && source.includes('切换模型超时，请重试');
  });
  if (!timeoutPatch) throw new Error('Model switching timeout recovery patch is missing.');

  const extraWindows = application.windows().filter((window) => window !== mainWindow && !window.url().startsWith('file:'));
  if (extraWindows.length) throw new Error(`Unexpected independent plugin window: ${JSON.stringify(extraWindows.map((window) => window.url()))}`);
  if (process.argv[2]) await mainWindow.screenshot({ path: process.argv[2] });
  await settings.getByRole('button', { name: '关闭' }).click();

  if (process.env.DSH_TEST_IMAGE) {
    const description = await application.evaluate(async ({ app }, imagePath) => {
      const path = process.getBuiltinModule('node:path');
      const fs = process.getBuiltinModule('node:fs');
      const { createRequire } = process.getBuiltinModule('node:module');
      const require = createRequire(path.join(app.getAppPath(), 'main.js'));
      const { createLocalVision } = require('./local-vision');
      const vision = createLocalVision({ cacheDir: path.join(app.getPath('userData'), 'models'),
        resolveProxy: (url) => require('electron').session.defaultSession.resolveProxy(url) });
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
    const pet = windows.find((window) => !window.isDestroyed() && window.getTitle() === 'DeepSeek yu 桌宠');
    return { mainVisible: main?.isVisible(), petVisible: pet?.isVisible(), petBounds: pet?.getBounds() };
  });
  if (background.mainVisible !== false || background.petVisible !== true || background.petBounds?.width !== 180) {
    throw new Error(`Background/pet sizing behavior failed: ${JSON.stringify(background)}`);
  }
  process.stdout.write(`desktop test passed: ${JSON.stringify(background)}\n`);
} finally {
  await application.close();
  await rm(testUserData, { recursive: true, force: true });
}
