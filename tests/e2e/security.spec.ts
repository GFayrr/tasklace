import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { closeDiscarding, launchApplication } from './application';

const ENTRY_URL = 'app://tasklace/index.html';
const FOREIGN_URL = 'https://example.com/';

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
    async ({ foreign }) => {
      const violation = new Promise<string>((resolve) => {
        document.addEventListener(
          'securitypolicyviolation',
          (event) => {
            resolve(event.blockedURI);
          },
          { once: true },
        );
      });
      const timerCode = 'window.ranStringCode = true;';
      Reflect.apply(setTimeout, window, [timerCode, 0]);
      const blocked = await violation;
      const evaluated = window.ranStringCode === true ? 'ran' : `refused (${blocked})`;
      const script = document.createElement('script');
      script.textContent = 'window.ranInlineScript = true;';
      document.body.append(script);
      const request = await fetch(foreign).then(
        () => 'loaded',
        () => 'refused',
      );
      return { evaluated, inline: window.ranInlineScript === true, request };
    },
    { foreign: FOREIGN_URL },
  );
  expect(outcome).toEqual({ evaluated: 'refused (eval)', inline: false, request: 'refused' });
});

test('stays on the application when the page tries to navigate or open windows', async () => {
  await application.evaluate(({ BrowserWindow }) => {
    const [window] = BrowserWindow.getAllWindows();
    window?.webContents.once('will-navigate', (event, url) => {
      Object.assign(globalThis, { navigation: { url, prevented: event.defaultPrevented } });
    });
  });
  const opened = await page.evaluate((foreign) => window.open(foreign) === null, FOREIGN_URL);
  await page.evaluate((foreign) => {
    window.location.href = foreign;
  }, FOREIGN_URL);
  await expect
    .poll(() => application.evaluate(() => Reflect.get(globalThis, 'navigation') as unknown))
    .toEqual({ url: FOREIGN_URL, prevented: true });
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
