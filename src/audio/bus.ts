/**
 * A tiny hook between the UI and the sound system, so that UI modules
 * (toasts, the stats bar, the welcome scenes) can ask for a sound without
 * importing it. Nothing happens until main.ts installs a sink.
 */
import type { Snapshot } from '../shared/protocol';
import type { UiSound } from './engine';
import type { View } from './mix';

export interface SoundSink {
  ui(kind: UiSound): void;
  /** A welcome scene's (or tool card's) snapshot and camera. */
  scene(s: Snapshot, view: View, width: number): void;
  sceneSplash(x: number, y: number): void;
  sceneEnd(): void;
}

let sink: SoundSink | null = null;

export function setSoundSink(s: SoundSink | null): void {
  sink = s;
}

export const sound = {
  ui: (kind: UiSound) => sink?.ui(kind),
  scene: (s: Snapshot, view: View, width: number) => sink?.scene(s, view, width),
  sceneSplash: (x: number, y: number) => sink?.sceneSplash(x, y),
  sceneEnd: () => sink?.sceneEnd(),
};

/** The mixer's view of a camera state and viewport. */
export function cameraView(c: { x: number; y: number; yaw: number; pitch: number; viewHeight: number }, width: number, height: number): View {
  return { x: c.x, y: c.y, yaw: c.yaw, pitch: c.pitch, viewHeight: c.viewHeight, aspect: Math.max(0.3, width / Math.max(1, height)) };
}
