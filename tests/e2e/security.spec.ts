import { readFileSync } from 'node:fs';
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const ENTRY_URL = 'app://tasklace/index.html';
const FOREIGN_URL = 'https://example.com/';
const REFUSED_ADDRESS = 'https://github.com.evil.example/GFayrr/tasklace';
const SETTLE_MS = 500;
const STRING_CODE_WAIT_MS = 100;
const version: unknown = Reflect.get(
  JSON.parse(readFileSync('package.json', 'utf8')) as object,
  'version',
);

let application: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  application = await electron.launch({ args: ['.'] });
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await application.close();
});

test('loads the interface from the application scheme, its own script running', async () => {
  expect(page.url()).toBe(ENTRY_URL);
  await expect(page.locator('#app')).toHaveAttribute('data-started', 'true');
});

test('gives the page no access to Node.js', async () => {
  const globals = await page.evaluate(() =>
    ['require', 'process', 'module', 'Buffer'].map((name) => typeof Reflect.get(window, name)),
  );
  expect(globals).toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
});

test('refuses code in strings, inline scripts and requests to other sites', async () => {
  const outcome = await page.evaluate(
    async ({ foreign, wait }) => {
      const timerCode = 'window.ranStringCode = true;';
      Reflect.apply(setTimeout, window, [timerCode, 0]);
      await new Promise((resolve) => setTimeout(resolve, wait));
      const evaluated = window.ranStringCode === true ? 'ran' : 'refused';
      const script = document.createElement('script');
      script.textContent = 'window.ranInlineScript = true;';
      document.body.append(script);
      const request = await fetch(foreign).then(
        () => 'loaded',
        () => 'refused',
      );
      return { evaluated, inline: window.ranInlineScript === true, request };
    },
    { foreign: FOREIGN_URL, wait: STRING_CODE_WAIT_MS },
  );
  expect(outcome).toEqual({ evaluated: 'refused', inline: false, request: 'refused' });
});

test('stays on the application when the page tries to navigate or open windows', async () => {
  const opened = await page.evaluate((foreign) => window.open(foreign) === null, FOREIGN_URL);
  await page.evaluate((foreign) => {
    window.location.href = foreign;
  }, FOREIGN_URL);
  await page.waitForTimeout(SETTLE_MS);
  expect(opened).toBe(true);
  expect(page.url()).toBe(ENTRY_URL);
  expect(application.windows()).toHaveLength(1);
});

test('refuses every permission the page asks for', async () => {
  const permission = await page.evaluate(() => Notification.requestPermission());
  expect(permission).toBe('denied');
});

test('exposes only the listed bridge functions, which check what they receive', async () => {
  const bridge = await page.evaluate(
    async ({ refused, WRONG_TYPE }) => {
      const api = window.tasklace;
      if (api === undefined) {
        return null;
      }
      return {
        keys: Object.keys(api).sort(),
        version: await api.appVersion(),
        refused: await api.openExternal(refused),
        wrongType: await api.openExternal(WRONG_TYPE),
      };
    },
    { refused: REFUSED_ADDRESS, WRONG_TYPE: 42 },
  );
  expect(bridge).toEqual({
    keys: [
      'appVersion',
      'exportProject',
      'importProject',
      'newProject',
      'onFlushRequested',
      'openExternal',
      'openProject',
      'openRecentProject',
      'recentProjects',
      'regionalFormat',
      'saveProject',
      'saveProjectAs',
    ],
    version,
    refused: false,
    wrongType: false,
  });
});
