import { describe, expect, it } from 'vitest';
import { encodeIco, pngSize, readIco } from './ico-file.ts';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52];

/** Makes the beginning of a PNG of a width and a height, followed by a few bytes that tell images apart. */
function fakePng(width: number, height: number, mark: number): Uint8Array {
  const bytes = new Uint8Array(28);
  bytes.set(PNG_SIGNATURE, 0);
  bytes.set(IHDR, 8);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.fill(mark, 24);
  return bytes;
}

describe('pngSize', () => {
  it('reads the width and height a PNG declares', () => {
    expect(pngSize(fakePng(48, 32, 1))).toEqual({ width: 48, height: 32 });
  });

  it('refuses bytes that are not a PNG or too short to hold its header', () => {
    const notPng = fakePng(16, 16, 1);
    notPng[1] = 0;
    expect(() => pngSize(notPng)).toThrow(new RangeError('An image of the icon is not a PNG.'));
    expect(() => pngSize(fakePng(16, 16, 1).subarray(0, 23))).toThrow(
      new RangeError('An image of the icon is not a PNG.'),
    );
  });
});

describe('encodeIco', () => {
  it('writes the header, one entry per image and the images one after the other', () => {
    const small = fakePng(16, 16, 7);
    const large = fakePng(256, 256, 9);
    const icon = encodeIco([
      { size: 16, png: small },
      { size: 256, png: large },
    ]);
    const view = new DataView(icon.buffer);
    expect([view.getUint16(0, true), view.getUint16(2, true), view.getUint16(4, true)]).toEqual([
      0, 1, 2,
    ]);
    expect([...icon.subarray(6, 22)]).toEqual([
      16, 16, 0, 0, 1, 0, 32, 0, 28, 0, 0, 0, 38, 0, 0, 0,
    ]);
    expect([...icon.subarray(22, 38)]).toEqual([0, 0, 0, 0, 1, 0, 32, 0, 28, 0, 0, 0, 66, 0, 0, 0]);
    expect([...icon.subarray(38, 66)]).toEqual([...small]);
    expect([...icon.subarray(66)]).toEqual([...large]);
  });

  it('gives back the same images when read', () => {
    const images = [16, 20, 24, 32, 40, 48, 64, 256].map((size, index) => ({
      size,
      png: fakePng(size, size, index),
    }));
    expect(readIco(encodeIco(images)).map(({ size, png }) => ({ size, png: [...png] }))).toEqual(
      images.map(({ size, png }) => ({ size, png: [...png] })),
    );
  });

  it('refuses no image, too many images, a size twice, a size the image does not have, and sizes outside 1 to 256', () => {
    expect(() => encodeIco([])).toThrow(new RangeError('An icon holds from 1 to 255 images.'));
    const many = Array.from({ length: 256 }, (_, index) => ({
      size: (index % 256) + 1,
      png: fakePng((index % 256) + 1, (index % 256) + 1, 0),
    }));
    expect(() => encodeIco(many)).toThrow(new RangeError('An icon holds from 1 to 255 images.'));
    expect(() =>
      encodeIco([
        { size: 16, png: fakePng(16, 16, 1) },
        { size: 16, png: fakePng(16, 16, 2) },
      ]),
    ).toThrow(new RangeError('The icon holds two images of 16 pixels.'));
    expect(() => encodeIco([{ size: 16, png: fakePng(16, 15, 1) }])).toThrow(
      new RangeError('An image of the icon is not a square of 16 pixels.'),
    );
    expect(() => encodeIco([{ size: 32, png: fakePng(16, 16, 1) }])).toThrow(
      new RangeError('An image of the icon is not a square of 32 pixels.'),
    );
    expect(() => encodeIco([{ size: 512, png: fakePng(512, 512, 1) }])).toThrow(
      new RangeError('An image of the icon is not a square of 512 pixels.'),
    );
    expect(() => encodeIco([{ size: 0, png: fakePng(0, 0, 1) }])).toThrow(
      new RangeError('An image of the icon is not a square of 0 pixels.'),
    );
  });
});

describe('readIco', () => {
  const icon = encodeIco([{ size: 32, png: fakePng(32, 32, 3) }]);

  it('refuses bytes that are not an icon', () => {
    const notAnIcon = new RangeError('These bytes are not a Windows icon.');
    expect(() => readIco(icon.subarray(0, 5))).toThrow(notAnIcon);
    const reserved = icon.slice();
    reserved[0] = 1;
    expect(() => readIco(reserved)).toThrow(notAnIcon);
    const cursor = icon.slice();
    cursor[2] = 2;
    expect(() => readIco(cursor)).toThrow(notAnIcon);
  });

  it('refuses a directory that is empty or cut short', () => {
    const incomplete = new RangeError('The directory of the icon is incomplete.');
    const empty = icon.slice(0, 6);
    empty[4] = 0;
    expect(() => readIco(empty)).toThrow(incomplete);
    expect(() => readIco(icon.subarray(0, 21))).toThrow(incomplete);
  });

  it('refuses an entry that points outside the file or whose height differs from its width', () => {
    const outside = new RangeError('An entry of the icon points outside the file.');
    expect(() => readIco(icon.subarray(0, icon.length - 1))).toThrow(outside);
    const uneven = icon.slice();
    uneven[7] = 16;
    expect(() => readIco(uneven)).toThrow(outside);
  });

  it('refuses an image that is not the size its entry announces', () => {
    const wrong = icon.slice();
    wrong[6] = 16;
    wrong[7] = 16;
    expect(() => readIco(wrong)).toThrow(
      new RangeError('An image of the icon is not a square of 16 pixels.'),
    );
  });
});
