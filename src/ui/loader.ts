/**
 * The loading picture of the welcome panels and tool cards: a village mill
 * by a weir, its wheel turning in the race, in a round frame on the panel's
 * background. A 24-frame sprite strip (loader-mill.webp, styles.css
 * `.mill-loader`) prerendered by the real engine (tools/shot-loader.ts) and
 * stepped by CSS. It shows while a live scene loads (introScenes.ts fades
 * the scene in over it); with `.still` on the art box (the scenes cannot
 * run) or reduced motion, the wheel stands still.
 */
export const LOADER_HTML = '<div class="mill-loader" aria-hidden="true"><div class="mill-loader-strip"></div></div>';
