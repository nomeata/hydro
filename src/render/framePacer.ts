/**
 * Frame pacing for the render loop (battery, heat): at most `cap` frames a
 * second whatever the display's refresh rate (60, 90, 120 Hz), evenly
 * spread. Called once per requestAnimationFrame; frames due within 40% of
 * a display frame are drawn now (rAF timestamps jitter), and a late frame
 * does not cause a burst of catch-up frames.
 */
export class FramePacer {
  private nextDue = -Infinity;
  private lastRaf: number | null = null;
  /** The display's frame interval (ms), smoothed. */
  private rafDt = 16.7;

  /** Whether to draw at this animation frame (`now`: its timestamp, ms) (drawn() sets the cap). */
  due(now: number): boolean {
    if (this.lastRaf !== null) this.rafDt += (Math.min(100, Math.max(4, now - this.lastRaf)) - this.rafDt) * 0.1;
    this.lastRaf = now;
    return now >= this.nextDue - this.rafDt * 0.4;
  }

  /** A frame was drawn at `now`. */
  drawn(now: number, cap: number): void {
    const iv = 1000 / cap;
    this.nextDue = Math.max(this.nextDue + iv, now + iv / 2);
  }
}
