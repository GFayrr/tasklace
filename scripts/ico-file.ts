export interface IcoImage {
  readonly size: number;
  readonly png: Uint8Array;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_WIDTH_OFFSET = 16;
const PNG_HEIGHT_OFFSET = 20;
const PNG_HEADER_BYTES = 24;
const ICO_HEADER_BYTES = 6;
const ICO_ENTRY_BYTES = 16;
const ICO_RESERVED_OFFSET = 0;
const ICO_RESERVED = 0;
const ICO_TYPE_OFFSET = 2;
const ICO_COUNT_OFFSET = 4;
const ENTRY_HEIGHT_OFFSET = 1;
const ENTRY_PLANES_OFFSET = 4;
const ENTRY_BITS_OFFSET = 6;
const ENTRY_LENGTH_OFFSET = 8;
const ENTRY_IMAGE_OFFSET = 12;
const ICO_TYPE_ICON = 1;
const ICO_PLANES = 1;
const ICO_BITS_PER_PIXEL = 32;
const MAX_ICO_SIZE = 256;
const MAX_ICO_IMAGES = 255;
const ICO_SIZE_OF_LARGEST = 0;

/** Reads the width and height a PNG declares in its header, throwing for bytes that are not a PNG. */
export function pngSize(png: Uint8Array): { readonly width: number; readonly height: number } {
  if (png.length < PNG_HEADER_BYTES || PNG_SIGNATURE.some((byte, index) => png[index] !== byte)) {
    throw new RangeError('An image of the icon is not a PNG.');
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(PNG_WIDTH_OFFSET), height: view.getUint32(PNG_HEIGHT_OFFSET) };
}

/** Packs square PNG images of distinct sizes up to 256 pixels into a Windows icon file, which stores them one after the other behind a directory of their sizes and places. */
export function encodeIco(images: readonly IcoImage[]): Uint8Array {
  checkImages(images);
  const directoryBytes = ICO_HEADER_BYTES + images.length * ICO_ENTRY_BYTES;
  const totalBytes = images.reduce((sum, image) => sum + image.png.length, directoryBytes);
  const bytes = new Uint8Array(totalBytes);
  const view = new DataView(bytes.buffer);
  view.setUint16(ICO_TYPE_OFFSET, ICO_TYPE_ICON, true);
  view.setUint16(ICO_COUNT_OFFSET, images.length, true);
  let offset = directoryBytes;
  images.forEach((image, index) => {
    const entry = ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES;
    const side = image.size === MAX_ICO_SIZE ? ICO_SIZE_OF_LARGEST : image.size;
    view.setUint8(entry, side);
    view.setUint8(entry + ENTRY_HEIGHT_OFFSET, side);
    view.setUint16(entry + ENTRY_PLANES_OFFSET, ICO_PLANES, true);
    view.setUint16(entry + ENTRY_BITS_OFFSET, ICO_BITS_PER_PIXEL, true);
    view.setUint32(entry + ENTRY_LENGTH_OFFSET, image.png.length, true);
    view.setUint32(entry + ENTRY_IMAGE_OFFSET, offset, true);
    bytes.set(image.png, offset);
    offset += image.png.length;
  });
  return bytes;
}

/** Throws unless there are images, each a square PNG of the size it claims, at most 256 pixels, with no size twice. */
function checkImages(images: readonly IcoImage[]): void {
  if (images.length === 0 || images.length > MAX_ICO_IMAGES) {
    throw new RangeError('An icon holds from 1 to 255 images.');
  }
  const sizes = new Set<number>();
  for (const image of images) {
    const { width, height } = pngSize(image.png);
    if (
      width !== image.size ||
      height !== image.size ||
      image.size < 1 ||
      image.size > MAX_ICO_SIZE
    ) {
      throw new RangeError(`An image of the icon is not a square of ${String(image.size)} pixels.`);
    }
    if (sizes.has(image.size)) {
      throw new RangeError(`The icon holds two images of ${String(image.size)} pixels.`);
    }
    sizes.add(image.size);
  }
}

/** Reads the images of a Windows icon file holding PNG images, throwing when its directory or an image is out of place. */
export function readIco(bytes: Uint8Array): IcoImage[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length < ICO_HEADER_BYTES ||
    view.getUint16(ICO_RESERVED_OFFSET, true) !== ICO_RESERVED ||
    view.getUint16(ICO_TYPE_OFFSET, true) !== ICO_TYPE_ICON
  ) {
    throw new RangeError('These bytes are not a Windows icon.');
  }
  const count = view.getUint16(ICO_COUNT_OFFSET, true);
  if (count === 0 || bytes.length < ICO_HEADER_BYTES + count * ICO_ENTRY_BYTES) {
    throw new RangeError('The directory of the icon is incomplete.');
  }
  return Array.from({ length: count }, (_, index) =>
    imageAt(bytes, view, ICO_HEADER_BYTES + index * ICO_ENTRY_BYTES),
  );
}

/** Reads the image a directory entry of an icon points to, checking that it lies within the file and is the PNG its entry announces. */
function imageAt(bytes: Uint8Array, view: DataView, entry: number): IcoImage {
  const side = view.getUint8(entry);
  const size = side === ICO_SIZE_OF_LARGEST ? MAX_ICO_SIZE : side;
  const length = view.getUint32(entry + ENTRY_LENGTH_OFFSET, true);
  const offset = view.getUint32(entry + ENTRY_IMAGE_OFFSET, true);
  if (view.getUint8(entry + ENTRY_HEIGHT_OFFSET) !== side || offset + length > bytes.length) {
    throw new RangeError('An entry of the icon points outside the file.');
  }
  const png = bytes.subarray(offset, offset + length);
  const { width, height } = pngSize(png);
  if (width !== size || height !== size) {
    throw new RangeError(`An image of the icon is not a square of ${String(size)} pixels.`);
  }
  return { size, png };
}
