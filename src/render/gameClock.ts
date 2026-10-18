/**
 * The renderer's one animation clock. Everything that shows game activity
 * (people, animals, smoke, wheels, foam, fish, rain, swaying crops, water
 * ripples) is driven from here rather than from wall time, so pausing
 * freezes the picture and a faster game livens it up within limits.
 *
 * - `play`: wall time while the game runs, stopped while paused. Movement
 *   that follows the simulation (crowd interpolation between snapshots,
 *   walk cycles matching that movement, gate leaves) uses it.
 * - `anim`: `play` scaled by a gentle, capped function of the game speed
 *   (1 at 1×, about 1.7 at 4×, at most 2). Ambient motion (idle poses,
 *   smoke, sways, ripples, precipitation) uses it.
 *
 * UI feedback (camera, brush cursor, tool previews) keeps wall time.
 */

/** Ambient animation rate for a game speed (0 = paused). */
export function animRate(gameSpeed: number): number {
  if (!(gameSpeed > 0)) return 0;
  return Math.min(2, Math.max(0.5, gameSpeed) ** 0.4);
}

export class GameClock {
  /** Game speed (0 = paused); set from snapshots. */
  gameSpeed = 1;
  /** Seconds of play this frame (0 while paused). */
  playDt = 0;
  /** Seconds of play since start. */
  playSec = 0;
  /** Ambient animation seconds this frame (0 while paused). */
  animDt = 0;
  /** Ambient animation seconds since start (kept below a day for float precision on the GPU). */
  animSec = 0;
  private rate = 1;

  /** Advance by `realDt` wall seconds. */
  tick(realDt: number): void {
    const dt = Math.max(0, realDt);
    const playing = this.gameSpeed > 0;
    // Ease the rate between speeds (the achieved speed wobbles), but stop at once on pause.
    const target = animRate(this.gameSpeed);
    this.rate = playing ? this.rate + (target - this.rate) * Math.min(1, dt * 2) : 0;
    if (playing && this.rate < 0.05) this.rate = target;
    this.playDt = playing ? dt : 0;
    this.playSec += this.playDt;
    this.animDt = this.playDt * this.rate;
    this.animSec = (this.animSec + this.animDt) % 86400;
  }

  /** `playSec` in milliseconds (the time base for snapshot interpolation). */
  get playMs(): number {
    return this.playSec * 1000;
  }
}
