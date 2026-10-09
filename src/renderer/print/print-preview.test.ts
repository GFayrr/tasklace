import { describe, expect, it } from 'vitest';
import {
  PATH_CLOSE,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  type PrintOrder,
} from '../../core/print/print-document';
import { recordingCanvas } from '../plan/testing/recording-canvas';
import { paintPrintPage } from './print-preview';

const SIZE = { width: 100, height: 50 };
const RECT = { kind: 'rect', x: 1, y: 2, width: 3, height: 4 } as const;
const STRIPES = { kind: 'stripes' } as unknown as CanvasPattern;

/** Paints orders on a recording canvas, noting each font set, and returns the names and arguments of its calls with the styles in force. */
function paint(
  orders: readonly PrintOrder[],
  pattern: CanvasPattern | null = STRIPES,
  fonts: string[] = [],
) {
  const { context, calls } = recordingCanvas();
  const watched = new Proxy(context, {
    set: (target, key, value: unknown) => {
      if (key === 'font') {
        fonts.push(String(value));
      }
      return Reflect.set(target, key, value);
    },
  });
  paintPrintPage(watched, orders, SIZE, 2, () => pattern);
  return calls;
}

describe('paintPrintPage', () => {
  it('scales the page and paints it white before its orders', () => {
    expect(paint([]).map((call) => [call.name, call.args, call.fillStyle])).toEqual([
      ['save', [], ''],
      ['scale', [2, 2], ''],
      ['fillRect', [0, 0, 100, 50], '#ffffff'],
      ['restore', [], '#ffffff'],
    ]);
  });

  it('fills a rectangle, with its opacity when it has one', () => {
    const calls = paint([
      { kind: 'fill', shape: RECT, color: '#2a78d6', opacity: 1 },
      { kind: 'fill', shape: RECT, color: '#2a78d6', opacity: 0.5 },
    ]);
    expect(calls.filter((call) => call.name === 'rect').map((call) => call.args)).toEqual([
      [1, 2, 3, 4],
      [1, 2, 3, 4],
    ]);
    expect(calls.filter((call) => call.name === 'fill').map((call) => call.fillStyle)).toEqual([
      '#2a78d6',
      'rgba(42, 120, 214, 0.5)',
    ]);
  });

  it('strokes a path of every operation with its width and dash, then clears the dash', () => {
    const calls = paint([
      {
        kind: 'stroke',
        shape: {
          kind: 'path',
          segments: [PATH_MOVE, 0, 0, PATH_LINE, 5, 0, PATH_CURVE, 1, 2, 3, 4, 5, 6, PATH_CLOSE],
        },
        color: '#5f5b55',
        opacity: 1,
        width: 1.5,
        dash: [3, 2],
      },
    ]);
    expect(
      calls
        .filter((call) => ['moveTo', 'lineTo', 'bezierCurveTo', 'closePath'].includes(call.name))
        .map((call) => [call.name, call.args]),
    ).toEqual([
      ['moveTo', [0, 0]],
      ['lineTo', [5, 0]],
      ['bezierCurveTo', [1, 2, 3, 4, 5, 6]],
      ['closePath', []],
    ]);
    const stroke = calls.find((call) => call.name === 'stroke');
    expect([stroke?.strokeStyle, stroke?.lineWidth, stroke?.lineDash]).toEqual([
      '#5f5b55',
      1.5,
      [3, 2],
    ]);
    expect(calls.filter((call) => call.name === 'setLineDash').map((call) => call.args)).toEqual([
      [[3, 2]],
      [[]],
    ]);
  });

  it('fills a pattern with the canvas pattern of the tag, or leaves it out when none can be made', () => {
    const order = { kind: 'pattern', shape: RECT, pattern: 'dots' } as const;
    expect(
      paint([order])
        .filter((call) => call.name === 'fill')
        .map((call) => call.fillStyle),
    ).toEqual([STRIPES]);
    expect(paint([order], null).filter((call) => call.name === 'fill')).toEqual([]);
  });

  it('writes a text with the printed font at its size in points, the page being scaled to pixels, with its color and alignment', () => {
    const fonts: string[] = [];
    const calls = paint(
      [
        {
          kind: 'text',
          x: 10,
          y: 20,
          text: 'Survey',
          size: 10,
          weight: 600,
          color: '#1c1b19',
          align: 'middle',
        },
      ],
      STRIPES,
      fonts,
    );
    const write = calls.find((call) => call.name === 'fillText');
    expect([write?.args, write?.fillStyle]).toEqual([['Survey', 10, 20], '#1c1b19']);
    expect(fonts).toEqual(['600 10px Jost']);
  });

  it('draws the orders of a clip inside its shape, between a save and a restore', () => {
    const calls = paint([
      {
        kind: 'clip',
        shape: RECT,
        orders: [
          {
            kind: 'clip',
            shape: RECT,
            orders: [{ kind: 'fill', shape: RECT, color: '#000000', opacity: 1 }],
          },
        ],
      },
    ]);
    expect(calls.map((call) => call.name)).toEqual([
      'save',
      'scale',
      'fillRect',
      'save',
      'beginPath',
      'rect',
      'clip',
      'save',
      'beginPath',
      'rect',
      'clip',
      'beginPath',
      'rect',
      'fill',
      'restore',
      'restore',
      'restore',
    ]);
  });
});
