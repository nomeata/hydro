/**
 * Pixel diff of two folders of screenshots (e.g. tools/perf-render.ts --shots before/after):
 *   npx tsx tools/shot-diff.ts dirA dirB   (writes dirB/diff-*.png)
 */
import { PNG } from 'pngjs';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const [a, b] = process.argv.slice(2);
for (const f of readdirSync(a!).filter((f) => f.endsWith('.png'))) {
  let pa: PNG, pb: PNG;
  try { pa = PNG.sync.read(readFileSync(`${a}/${f}`)); pb = PNG.sync.read(readFileSync(`${b}/${f}`)); } catch { continue; }
  let n = 0, big = 0;
  const out = new PNG({ width: pa.width, height: pa.height });
  for (let i = 0; i < pa.data.length; i += 4) {
    const d = Math.max(Math.abs(pa.data[i]! - pb.data[i]!), Math.abs(pa.data[i + 1]! - pb.data[i + 1]!), Math.abs(pa.data[i + 2]! - pb.data[i + 2]!));
    if (d > 4) n++;
    if (d > 24) big++;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = 255 - Math.min(255, d * 4);
    out.data[i + 3] = 255;
  }
  writeFileSync(`${b}/diff-${f}`, PNG.sync.write(out));
  const N = pa.width * pa.height;
  console.log(f, `changed >4: ${((100 * n) / N).toFixed(2)}%  >24: ${((100 * big) / N).toFixed(2)}%`);
}
