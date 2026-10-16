/**
 * Default pointer/wheel handling for the camera.
 *
 * Mouse: left-drag pans, middle-drag pans, right-drag rotates (horizontal)
 * and tilts (vertical), shift+left-drag rotates/tilts, wheel zooms toward the
 * cursor. Touch: one finger pans, two fingers pan + pinch-zoom + twist-rotate,
 * three fingers drag vertically to tilt.
 *
 * With `setPrimaryPointerEnabled(false)` (a UI tool is active) single-finger
 * touches and left-mouse drags are ignored (not captured, not
 * preventDefault'ed) so the tool can use them, while two-finger gestures,
 * right/middle mouse and wheel keep working.
 */
import type { CameraController } from './camera';

export interface CameraInputOptions {
  /** Initial state of single-finger / left-mouse camera control (default true). */
  primaryPointerEnabled?: boolean;
  /** Called when a multi-touch camera gesture starts (UI tools should cancel their stroke). */
  onGestureStart?: () => void;
  /** Radians per pixel for drag rotation (default 0.006). */
  rotateSpeed?: number;
  /** Radians per pixel for tilting (default 0.004). */
  tiltSpeed?: number;
  /** Wheel zoom sensitivity per deltaY pixel (default 0.0015). */
  wheelSpeed?: number;
}

export interface CameraInputHandle {
  setPrimaryPointerEnabled(enabled: boolean): void;
  readonly primaryPointerEnabled: boolean;
  dispose(): void;
}

interface Ptr {
  x: number;
  y: number;
  type: string;
  /** For mice: 'pan' | 'rotate'. For touches: always tracked. */
  mode: 'pan' | 'rotate' | 'touch';
}

export function attachCameraInput(
  el: HTMLElement,
  camera: CameraController,
  opts: CameraInputOptions = {},
): CameraInputHandle {
  let primary = opts.primaryPointerEnabled ?? true;
  const rotateSpeed = opts.rotateSpeed ?? 0.006;
  const tiltSpeed = opts.tiltSpeed ?? 0.004;
  const wheelSpeed = opts.wheelSpeed ?? 0.0015;
  const ptrs = new Map<number, Ptr>();
  // Two-finger gesture reference (centroid, distance, angle).
  let gesture: { cx: number; cy: number; dist: number; angle: number; n: number } | null = null;

  el.style.touchAction = 'none';

  const touches = (): Ptr[] => [...ptrs.values()].filter((p) => p.mode === 'touch');

  const gestureMeasure = (): { cx: number; cy: number; dist: number; angle: number; n: number } => {
    const ts = touches();
    let cx = 0;
    let cy = 0;
    for (const t of ts) {
      cx += t.x;
      cy += t.y;
    }
    cx /= ts.length;
    cy /= ts.length;
    let dist = 0;
    let angle = 0;
    if (ts.length >= 2) {
      const a = ts[0]!;
      const b = ts[1]!;
      dist = Math.hypot(b.x - a.x, b.y - a.y);
      angle = Math.atan2(b.y - a.y, b.x - a.x);
    }
    return { cx, cy, dist, angle, n: ts.length };
  };

  const onDown = (e: PointerEvent): void => {
    if (e.pointerType === 'touch' || e.pointerType === 'pen') {
      ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType, mode: 'touch' });
      const n = touches().length;
      if (n >= 2) {
        gesture = gestureMeasure();
        if (n === 2) opts.onGestureStart?.();
        capture(e);
        e.preventDefault();
      } else if (primary) {
        gesture = null;
        capture(e);
        e.preventDefault();
      }
      return;
    }
    // Mouse.
    let mode: Ptr['mode'] | null = null;
    if (e.button === 0) mode = e.shiftKey ? 'rotate' : primary ? 'pan' : null;
    else if (e.button === 1) mode = 'pan';
    else if (e.button === 2) mode = 'rotate';
    if (!mode) return;
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY, type: 'mouse', mode });
    capture(e);
    e.preventDefault();
  };

  const onMove = (e: PointerEvent): void => {
    const p = ptrs.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x;
    const dy = e.clientY - p.y;
    p.x = e.clientX;
    p.y = e.clientY;
    if (p.mode === 'pan') {
      camera.panBy(dx, dy);
    } else if (p.mode === 'rotate') {
      camera.rotateBy(-dx * rotateSpeed);
      camera.tiltBy(dy * tiltSpeed);
    } else {
      const n = touches().length;
      if (n === 1) {
        if (primary) camera.panBy(dx, dy);
        return;
      }
      if (!gesture) {
        gesture = gestureMeasure();
        return;
      }
      const m = gestureMeasure();
      if (m.n !== gesture.n) {
        gesture = m;
        return;
      }
      if (n >= 3) {
        camera.tiltBy((m.cy - gesture.cy) * tiltSpeed);
      } else {
        camera.panBy(m.cx - gesture.cx, m.cy - gesture.cy);
        if (gesture.dist > 10 && m.dist > 10) camera.zoomBy(m.dist / gesture.dist, m.cx, m.cy);
        let da = m.angle - gesture.angle;
        if (da > Math.PI) da -= 2 * Math.PI;
        if (da < -Math.PI) da += 2 * Math.PI;
        // Fingers turning clockwise on screen turn the world clockwise.
        camera.rotateBy(da, m.cx, m.cy);
      }
      gesture = m;
    }
    e.preventDefault();
  };

  const onUp = (e: PointerEvent): void => {
    if (!ptrs.delete(e.pointerId)) return;
    const n = touches().length;
    gesture = n >= 2 ? gestureMeasure() : null;
  };

  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= 400;
    // Trackpad pinch arrives as ctrl+wheel with small deltas.
    const speed = e.ctrlKey ? wheelSpeed * 6 : wheelSpeed;
    camera.zoomBy(Math.exp(-dy * speed), e.clientX, e.clientY);
  };

  const onContext = (e: Event): void => e.preventDefault();

  function capture(e: PointerEvent): void {
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer may already be gone */
    }
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('lostpointercapture', onUp);
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', onContext);

  return {
    setPrimaryPointerEnabled(enabled: boolean): void {
      primary = enabled;
      if (!enabled) {
        // Drop an in-progress single-pointer pan.
        for (const [id, p] of ptrs) if (p.mode === 'pan' && p.type === 'mouse') ptrs.delete(id);
      }
    },
    get primaryPointerEnabled(): boolean {
      return primary;
    },
    dispose(): void {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      el.removeEventListener('lostpointercapture', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', onContext);
      ptrs.clear();
    },
  };
}
