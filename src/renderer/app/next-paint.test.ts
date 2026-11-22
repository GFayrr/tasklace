import { describe, expect, it } from 'vitest';
import { nextPaint } from './next-paint';

describe('nextPaint', () => {
  it('resolves after the frame asked for, and after the work that frame queued', async () => {
    const steps: string[] = [];
    const painted = nextPaint().then(() => {
      steps.push('painted');
    });
    requestAnimationFrame(() => {
      steps.push('frame');
    });
    await painted;
    expect(steps).toEqual(['frame', 'painted']);
  });
});
