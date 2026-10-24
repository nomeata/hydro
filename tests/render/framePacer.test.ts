import { describe, expect, it } from 'vitest';
import { FramePacer } from '../../src/render/framePacer';

/** Frames drawn per second over 10 s of a display at `hz` (± `jitter` ms per frame). */
function rate(hz: number, cap: number, jitter = 0): { fps: number; maxGap: number } {
  const p = new FramePacer();
  let drawn = 0;
  let last = 0;
  let maxGap = 0;
  let seed = 1;
  for (let k = 0; k < hz * 10; k++) {
    seed = (seed * 16807) % 2147483647;
    const now = (k * 1000) / hz + (seed / 2147483647 - 0.5) * 2 * jitter;
    if (!p.due(now)) continue;
    p.drawn(now, cap);
    if (k > hz) maxGap = Math.max(maxGap, now - last);
    last = now;
    drawn++;
  }
  return { fps: drawn / 10, maxGap };
}

describe('FramePacer', () => {
  it('caps the frame rate whatever the display refresh', () => {
    for (const hz of [60, 90, 120, 144]) {
      expect(rate(hz, 60).fps).toBeGreaterThan(55);
      expect(rate(hz, 60).fps).toBeLessThanOrEqual(61);
      expect(rate(hz, 30).fps).toBeGreaterThan(28);
      expect(rate(hz, 30).fps).toBeLessThanOrEqual(31);
    }
  });

  it('spreads frames evenly and tolerates timestamp jitter', () => {
    // 60 Hz, cap 30: every other frame, never three frames apart.
    const r = rate(60, 30, 2);
    expect(r.fps).toBeGreaterThan(29);
    expect(r.maxGap).toBeLessThan(40);
    // A 60 Hz display under a 60 cap draws every frame.
    expect(rate(60, 60, 2).fps).toBeGreaterThan(59);
  });

  it('does not burst after a long frame', () => {
    const p = new FramePacer();
    let t = 0;
    for (; t < 1000; t += 16.7) if (p.due(t)) p.drawn(t, 30);
    // A 300 ms hitch, then frames resume: drawn at once, but no catch-up burst.
    t += 300;
    expect(p.due(t)).toBe(true);
    p.drawn(t, 30);
    let n = 0;
    for (let k = 1; k <= 12; k++)
      if (p.due(t + k * 16.7)) {
        p.drawn(t + k * 16.7, 30);
        n++;
      }
    expect(n).toBeLessThanOrEqual(7);
  });
});
