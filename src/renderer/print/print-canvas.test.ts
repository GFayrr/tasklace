import { describe, expect, it } from 'vitest';
import {
  PATH_CLOSE,
  PATH_CURVE,
  PATH_LINE,
  PATH_MOVE,
  pathSegments,
  type PrintOrder,
} from '../../core/print/print-document';
import { PrintCanvas, printPattern } from './print-canvas';

const AREA = { x: 100, y: 50, width: 400, height: 300 };
const BLEED = 8;

/** Creates a print canvas over the sample printed area. */
function canvas(): PrintCanvas {
  return new PrintCanvas(AREA);
}

describe('PrintCanvas', () => {
  it('records a filled rectangle in the fill color, placed by the translation and scale in force', () => {
    const print = canvas();
    const { context } = print;
    context.translate(100, 50);
    context.scale(0.5, 0.5);
    context.fillStyle = '#2A78D6';
    context.fillRect(10, 20, 40, 60);
    expect(print.orders()).toEqual([
      {
        kind: 'fill',
        shape: { kind: 'rect', x: 105, y: 60, width: 20, height: 30 },
        color: '#2a78d6',
        opacity: 1,
      },
    ]);
  });

  it('reads colors written rgb or rgba as a color and an opacity', () => {
    const print = canvas();
    print.context.fillStyle = 'rgba(0, 0, 0, 0.35)';
    print.context.fillRect(100, 50, 1, 1);
    print.context.fillStyle = 'rgb(255, 16, 1)';
    print.context.fillRect(100, 50, 1, 1);
    expect(
      print.orders().map((order) => order.kind === 'fill' && [order.color, order.opacity]),
    ).toEqual([
      ['#000000', 0.35],
      ['#ff1001', 1],
    ]);
  });

  it('gives back the styles last set', () => {
    const { context } = canvas();
    context.fillStyle = '#AABBCC';
    context.strokeStyle = 'rgb(1, 2, 3)';
    context.lineWidth = 3;
    expect([context.fillStyle, context.strokeStyle, context.lineWidth]).toEqual([
      '#AABBCC',
      'rgb(1, 2, 3)',
      3,
    ]);
  });

  it.each([['red'], ['#abc'], ['rgb(256, 0, 0)'], ['rgba(0, 0, 0, 2)'], ['hsl(0, 0%, 0%)']])(
    'refuses the color %s, which the timeline never uses',
    (color) => {
      expect(() => {
        canvas().context.fillStyle = color;
      }).toThrow(`Unknown color to print: ${color}`);
    },
  );

  it('refuses a canvas pattern that is no tag pattern, and a pattern for lines', () => {
    const { context } = canvas();
    expect(() => {
      context.fillStyle = {} as CanvasPattern;
    }).toThrow('Only tag patterns can be printed.');
    expect(() => {
      context.strokeStyle = printPattern('dots');
    }).toThrow('A printed line cannot be drawn with a pattern.');
  });

  it('refuses a drawing call or a setting it does not know rather than leaving it out', () => {
    const { context } = canvas();
    expect(() => {
      context.fillText('Late', 0, 0);
    }).toThrow(TypeError);
    expect(() => {
      context.lineCap = 'round';
    }).toThrow(TypeError);
  });

  it('records a tag pattern as a pattern order over the same shape', () => {
    const print = canvas();
    print.context.fillStyle = printPattern('crossHatch');
    print.context.fillRect(120, 60, 30, 10);
    expect(print.orders()).toEqual([
      {
        kind: 'pattern',
        shape: { kind: 'rect', x: 120, y: 60, width: 30, height: 10 },
        pattern: 'crossHatch',
      },
    ]);
  });

  it('strokes a path with its width and dash scaled like the drawing, starting it at the first line when there was no move', () => {
    const print = canvas();
    const { context } = print;
    context.scale(2, 2);
    context.strokeStyle = '#5f5b55';
    context.lineWidth = 1.5;
    context.setLineDash([4, 3]);
    context.beginPath();
    context.lineTo(60, 40);
    context.lineTo(70, 40);
    context.closePath();
    context.stroke();
    expect(print.orders()).toEqual([
      {
        kind: 'stroke',
        shape: {
          kind: 'path',
          segments: [PATH_MOVE, 120, 80, PATH_LINE, 120, 80, PATH_LINE, 140, 80, PATH_CLOSE],
        },
        color: '#5f5b55',
        opacity: 1,
        width: 3,
        dash: [8, 6],
      },
    ]);
  });

  it('strokes the outline of a rectangle', () => {
    const print = canvas();
    print.context.strokeStyle = '#a93333';
    print.context.lineWidth = 2;
    print.context.strokeRect(110, 60, 10, 5);
    expect(print.orders()).toEqual([
      {
        kind: 'stroke',
        shape: { kind: 'rect', x: 110, y: 60, width: 10, height: 5 },
        color: '#a93333',
        opacity: 1,
        width: 2,
        dash: [],
      },
    ]);
  });

  it('turns a rounded rectangle into lines and quarter circles that start and end on its sides', () => {
    const print = canvas();
    print.context.beginPath();
    print.context.roundRect(110, 60, 40, 20, 5);
    print.context.fill();
    const [order] = print.orders();
    const segments =
      order?.kind === 'fill' && order.shape.kind === 'path' ? order.shape.segments : [];
    const read = pathSegments(segments);
    expect(read.map((segment) => segment.kind)).toEqual([
      'move',
      'line',
      'curve',
      'line',
      'curve',
      'line',
      'curve',
      'line',
      'curve',
      'close',
    ]);
    const ends = read.flatMap((segment) =>
      segment.kind === 'close' ? [] : [[segment.x, segment.y]],
    );
    expect(
      ends.map(([x = 0, y = 0]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000]),
    ).toEqual([
      [115, 60],
      [145, 60],
      [150, 65],
      [150, 75],
      [145, 80],
      [115, 80],
      [110, 75],
      [110, 65],
      [115, 60],
    ]);
  });

  it('keeps the corners of a rounded rectangle within half its smaller side, and makes them square at zero', () => {
    const print = canvas();
    print.context.beginPath();
    print.context.roundRect(110, 60, 4, 20, 0);
    print.context.fill();
    const [order] = print.orders();
    const segments =
      order?.kind === 'fill' && order.shape.kind === 'path' ? order.shape.segments : [];
    expect(segments).toEqual([
      PATH_MOVE,
      110,
      60,
      PATH_LINE,
      114,
      60,
      PATH_LINE,
      114,
      80,
      PATH_LINE,
      110,
      80,
      PATH_LINE,
      110,
      60,
      PATH_CLOSE,
    ]);
  });

  it('draws a whole circle as four curves whose points lie on the circle', () => {
    const print = canvas();
    print.context.beginPath();
    print.context.arc(200, 100, 10, 0, Math.PI * 2);
    print.context.fill();
    const [order] = print.orders();
    const segments =
      order?.kind === 'fill' && order.shape.kind === 'path' ? order.shape.segments : [];
    const curves = pathSegments(segments).filter((segment) => segment.kind === 'curve');
    expect(curves).toHaveLength(4);
    for (const curve of curves) {
      expect(Math.hypot(curve.x - 200, curve.y - 100)).toBeCloseTo(10, 9);
    }
    expect(segments[0]).toBe(PATH_MOVE);
    expect(segments.filter((value) => value === PATH_CURVE)).toHaveLength(4);
  });

  it('joins an arc to the path with a line only when it starts elsewhere', () => {
    const print = canvas();
    const { context } = print;
    context.beginPath();
    context.moveTo(210, 100);
    context.arc(200, 100, 10, 0, Math.PI / 2);
    context.moveTo(150, 100);
    context.arc(200, 100, 10, 0, Math.PI / 2);
    context.stroke();
    const [order] = print.orders();
    const segments =
      order?.kind === 'stroke' && order.shape.kind === 'path' ? order.shape.segments : [];
    expect(pathSegments(segments).map((segment) => segment.kind)).toEqual([
      'move',
      'curve',
      'move',
      'line',
      'curve',
    ]);
  });

  it('drops what lies wholly outside the printed area and its bleed, and cuts what lies across its edge', () => {
    const print = canvas();
    const { context } = print;
    context.fillStyle = '#000000';
    context.fillRect(-500, 60, 100, 10);
    context.fillRect(AREA.x + AREA.width + BLEED + 1, 60, 10, 10);
    context.fillRect(-100_000, 60, 200_000, 10);
    context.beginPath();
    context.moveTo(-90_000, 70);
    context.lineTo(150, 70);
    context.lineTo(150, 90_000);
    context.stroke();
    context.beginPath();
    context.moveTo(-500, -500);
    context.lineTo(-400, -400);
    context.stroke();
    expect(print.orders()).toEqual([
      {
        kind: 'fill',
        shape: {
          kind: 'rect',
          x: AREA.x - BLEED,
          y: 60,
          width: AREA.width + BLEED * 2,
          height: 10,
        },
        color: '#000000',
        opacity: 1,
      },
      {
        kind: 'stroke',
        shape: {
          kind: 'path',
          segments: [
            PATH_MOVE,
            AREA.x - BLEED,
            70,
            PATH_LINE,
            150,
            70,
            PATH_LINE,
            150,
            AREA.y + AREA.height + BLEED,
          ],
        },
        color: '#000000',
        opacity: 1,
        width: 1,
        dash: [],
      },
    ]);
  });

  it('records nothing for an invisible paint, an empty path or a stroke of no width', () => {
    const print = canvas();
    const { context } = print;
    context.fillStyle = 'rgba(0, 0, 0, 0)';
    context.fillRect(110, 60, 10, 10);
    context.fillStyle = '#000000';
    context.beginPath();
    context.fill();
    context.closePath();
    context.lineWidth = 0;
    context.strokeRect(110, 60, 10, 10);
    expect(print.orders()).toEqual([]);
  });

  it('keeps the drawings after a clip inside it until the state is restored, the restored state included', () => {
    const print = canvas();
    const { context } = print;
    context.fillStyle = '#111111';
    context.save();
    context.fillStyle = '#222222';
    context.translate(10, 0);
    context.beginPath();
    context.roundRect(110, 60, 40, 20, 0);
    context.clip();
    context.fillRect(110, 60, 40, 20);
    context.restore();
    context.restore();
    context.fillRect(110, 60, 1, 1);
    const orders = print.orders();
    expect(orders.map((order) => order.kind)).toEqual(['clip', 'fill']);
    const [clip, after] = orders as [PrintOrder, PrintOrder];
    expect(clip.kind === 'clip' && clip.orders).toEqual([
      {
        kind: 'fill',
        shape: { kind: 'rect', x: 120, y: 60, width: 40, height: 20 },
        color: '#222222',
        opacity: 1,
      },
    ]);
    expect(after).toEqual({
      kind: 'fill',
      shape: { kind: 'rect', x: 110, y: 60, width: 1, height: 1 },
      color: '#111111',
      opacity: 1,
    });
  });

  it('nests clips, drops a clip that holds nothing and closes the clips left open at the end', () => {
    const print = canvas();
    const { context } = print;
    context.fillStyle = '#000000';
    context.save();
    context.beginPath();
    context.roundRect(110, 60, 40, 20, 0);
    context.clip();
    context.restore();
    context.beginPath();
    context.roundRect(110, 60, 40, 20, 0);
    context.clip();
    context.beginPath();
    context.roundRect(120, 60, 40, 20, 0);
    context.clip();
    context.fillRect(110, 60, 5, 5);
    const orders = print.orders();
    expect(orders).toHaveLength(1);
    const outer = orders[0];
    const inner = outer?.kind === 'clip' ? outer.orders[0] : undefined;
    expect(inner?.kind === 'clip' && inner.orders.map((order) => order.kind)).toEqual(['fill']);
  });

  it('hides every drawing inside a clip outside the printed area until the state is restored', () => {
    const print = canvas();
    const { context } = print;
    context.fillStyle = '#000000';
    context.save();
    context.beginPath();
    context.roundRect(-900, 60, 40, 20, 0);
    context.clip();
    context.fillRect(110, 60, 5, 5);
    context.beginPath();
    context.roundRect(110, 60, 40, 20, 0);
    context.clip();
    context.fillRect(110, 60, 5, 5);
    context.restore();
    context.fillRect(110, 60, 5, 5);
    expect(print.orders().map((order) => order.kind)).toEqual(['fill']);
  });

  it('ignores a restore without a save, as a canvas does', () => {
    const print = canvas();
    print.context.restore();
    print.context.fillRect(110, 60, 5, 5);
    expect(print.orders()).toHaveLength(1);
  });
});
