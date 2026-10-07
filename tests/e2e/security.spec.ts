import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { closeDiscarding, launchApplication } from './application';

const ENTRY_URL = 'app://tasklace/index.html';
const FOREIGN_URL = 'https://example.com/';
const SETTLE_MS = 500;
const STRING_CODE_WAIT_MS = 100;

let application: ElectronApplication;
let page: Page;

test.beforeEach(async () => {
  application = await launchApplication();
  page = await application.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await closeDiscarding(application, page);
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
  const bridge = await page.evaluate(async (wrongPosition) => {
    const api = window.tasklace;
    if (api === undefined) {
      return null;
    }
    return {
      keys: Object.keys(api).sort(),
      wrongType: await api.openRecentProject(wrongPosition).then(
        () => 'answered',
        () => 'refused',
      ),
    };
  }, -1);
  expect(bridge).toEqual({
    keys: [
      'adoptProject',
      'exportProject',
      'importProject',
      'newProject',
      'onFlushRequested',
      'openProject',
      'openRecentProject',
      'recentProjects',
      'regionalFormat',
      'reportStartFailure',
      'saveProject',
      'saveProjectAs',
    ],
    wrongType: 'refused',
  });
});

test('shows no default menu, which would offer developer tools and reloading', async () => {
  const menu = await application.evaluate(({ Menu }) => Menu.getApplicationMenu());
  expect(menu).toBeNull();
});
