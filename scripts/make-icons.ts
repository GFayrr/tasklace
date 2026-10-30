import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { encodeIco, pngSize, type IcoImage } from './ico-file.ts';

const ICON_FOLDER = join(import.meta.dirname, '..', 'build', 'icons');
const WINDOW_ICON = join(import.meta.dirname, '..', 'resources', 'icon.png');
const SMALL_SIZES = [16, 20, 24];
const LARGE_SIZES = [32, 40, 48, 64, 256];
const WINDOW_ICON_SIZE = 256;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const ICONS = [
  { name: 'tasklace', small: 'tasklace-small.svg', large: 'tasklace.svg' },
  { name: 'tasklace-file', small: 'tasklace-file-small.svg', large: 'tasklace-file.svg' },
];

/** Draws a SVG at a size of pixels on a transparent canvas of a hidden page and returns it as a PNG. */
async function drawPng(page: BrowserWindow, svg: string, size: number): Promise<Uint8Array> {
  const source = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const drawn: unknown = await page.webContents.executeJavaScript(`(async () => {
    const image = new Image();
    image.src = ${JSON.stringify(source)};
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = ${String(size)};
    canvas.height = ${String(size)};
    canvas.getContext('2d').drawImage(image, 0, 0, ${String(size)}, ${String(size)});
    return canvas.toDataURL('image/png');
  })()`);
  if (typeof drawn !== 'string' || !drawn.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new Error(`The page did not draw the icon at ${String(size)} pixels.`);
  }
  const png = new Uint8Array(Buffer.from(drawn.slice(PNG_DATA_URL_PREFIX.length), 'base64'));
  const { width, height } = pngSize(png);
  if (width !== size || height !== size) {
    throw new Error(
      `The icon drawn at ${String(size)} pixels came out at ${String(width)} by ${String(height)}.`,
    );
  }
  return png;
}

/** Draws one icon at every size from its small and large drawings and writes it as a Windows icon file, returning its image of 256 pixels. */
async function makeIcon(page: BrowserWindow, icon: (typeof ICONS)[number]): Promise<Uint8Array> {
  const small = await readFile(join(ICON_FOLDER, icon.small), 'utf8');
  const large = await readFile(join(ICON_FOLDER, icon.large), 'utf8');
  const images: IcoImage[] = [];
  for (const size of SMALL_SIZES) {
    images.push({ size, png: await drawPng(page, small, size) });
  }
  for (const size of LARGE_SIZES) {
    images.push({ size, png: await drawPng(page, large, size) });
  }
  await writeFile(join(ICON_FOLDER, `${icon.name}.ico`), encodeIco(images));
  const largest = images.find((image) => image.size === WINDOW_ICON_SIZE);
  if (largest === undefined) {
    throw new Error(`The icon ${icon.name} has no image of ${String(WINDOW_ICON_SIZE)} pixels.`);
  }
  return largest.png;
}

/** Draws every icon of the application from its SVG sources, one after the other, and writes the window icon from the application icon. */
async function makeIcons(): Promise<void> {
  const page = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  try {
    await page.loadURL('about:blank');
    const largest: Uint8Array[] = [];
    for (const icon of ICONS) {
      largest.push(await makeIcon(page, icon));
    }
    const [applicationIcon] = largest;
    if (applicationIcon === undefined) {
      throw new Error('No icon was drawn.');
    }
    await writeFile(WINDOW_ICON, applicationIcon);
  } finally {
    page.destroy();
  }
}

app
  .whenReady()
  .then(makeIcons)
  .then(
    () => {
      app.quit();
    },
    (error: unknown) => {
      console.error('The icons could not be made:', error);
      app.exit(1);
    },
  );
