import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PAINT_WAIT_MILLISECONDS, nextPaint } from './next-paint';

/** Records when a paint wait resolves, by the steps taken before it. */
function watched(steps: string[]): Promise<void> {
  return nextPaint().then(() => {
    steps.push('painted');
  });
}

describe('nextPaint', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('resolves only after the callbacks of the frame it asked for have run', async () => {
    const steps: string[] = [];
    const painted = watched(steps);
    requestAnimationFrame(() => {
      steps.push('frame');
    });
    await painted;
    expect(steps).toEqual(['frame', 'painted']);
  });

  it('resolves after a short wait at most when no frame comes, as in a window the system hides', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', () => 0);
    const steps: string[] = [];
    const painted = watched(steps);
    await vi.advanceTimersByTimeAsync(MAX_PAINT_WAIT_MILLISECONDS - 1);
    steps.push('waited');
    await vi.advanceTimersByTimeAsync(1);
    await painted;
    expect(steps).toEqual(['waited', 'painted']);
  });

  it('resolves at once for a hidden page, without asking for a frame', async () => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    const frames = vi.fn(() => 0);
    vi.stubGlobal('requestAnimationFrame', frames);
    await nextPaint();
    expect(frames).not.toHaveBeenCalled();
  });
});
