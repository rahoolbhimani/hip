/**
 * Landmark detection accuracy on real radiographs.
 *
 *   EVAL_DIR=/path/to/cases npm run eval
 *
 * EVAL_DIR holds de-identified images (PNG, JPEG or DICOM) and, for each,
 * the case file saved from the app after marking/confirming the landmarks
 * by hand (`<name>.plan.json`, whose "image" field names the image file).
 * The confirmed points are the ground truth; the automatic detector is run
 * on each image and its error is reported per landmark type. A Markdown
 * report is written to EVAL_DIR/eval-report.md.
 *
 * Images never leave the machine this runs on.
 */
import { describe, it } from 'vitest';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
import { fromRGBA, type GrayImage } from '../src/imaging/gray';
import { loadDicom } from '../src/imaging/load';
import { autoDetectLandmarks, type AutoSide } from '../src/imaging/autoLandmarks';
import { finalPoint } from '../src/app/store';
import type { CaseData, LandmarkKey, Side } from '../src/planning/types';
import type { Vec2 } from '../src/geometry/vec';

const dir = process.env.EVAL_DIR;

function decodeJpeg(bytes: Uint8Array): GrayImage {
  const img = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 2048 });
  return fromRGBA(new Uint8ClampedArray(img.data.buffer), img.width, img.height);
}

async function loadImage(path: string): Promise<GrayImage> {
  const buf = new Uint8Array(readFileSync(path));
  const ext = extname(path).toLowerCase();
  if (ext === '.png') {
    const png = PNG.sync.read(Buffer.from(buf));
    return fromRGBA(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), png.width, png.height);
  }
  if (ext === '.jpg' || ext === '.jpeg') return decodeJpeg(buf);
  return (await loadDicom(buf, path, async (b) => decodeJpeg(b))).gray;
}

const KEYS: LandmarkKey[] = ['teardrop', 'head', 'lesserTrochanter', 'canal'];

function autoPoint(a: AutoSide, key: LandmarkKey): Vec2 | undefined {
  if (key === 'head') return a.head?.center;
  if (key === 'canal') return a.canalSeeds?.[0];
  if (key === 'teardrop') return a.teardrop;
  if (key === 'lesserTrochanter') return a.lesserTrochanter;
  return undefined;
}

function pct(values: number[], p: number): number {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
}

describe.skipIf(!dir)('landmark detection on real cases', () => {
  it('reports accuracy', async () => {
    const files = readdirSync(dir!).filter((f) => f.endsWith('.plan.json'));
    const errors: Record<string, number[]> = Object.fromEntries(KEYS.map((k) => [k, []]));
    const missed: Record<string, number> = Object.fromEntries(KEYS.map((k) => [k, 0]));
    const perCase: string[] = [];
    let markerErr: number[] = [];
    for (const f of files) {
      const json = JSON.parse(readFileSync(join(dir!, f), 'utf8'));
      const c = json.case as CaseData;
      const imgPath = join(dir!, json.image ?? f.replace('.plan.json', '.png'));
      if (!existsSync(imgPath) || !c.calibration) {
        perCase.push(`| ${f} | skipped (image or calibration missing) |`);
        continue;
      }
      const gray = await loadImage(imgPath);
      const mmPerPx = c.calibration.mmPerPx;
      // Landmarks are evaluated with the case's own calibration so scale errors don't mix in.
      const res = autoDetectLandmarks(gray, { mmPerPx, standardOrientation: c.standardOrientation });
      const cells: string[] = [];
      for (const side of ['R', 'L'] as Side[]) {
        for (const key of KEYS) {
          const truth = finalPoint(c.landmarks[side], key);
          if (!truth) continue;
          const auto = autoPoint(res.sides[side], key);
          if (!auto) {
            missed[key]++;
            cells.push(`${key} ${side}: missed`);
            continue;
          }
          const mm = Math.hypot(auto.x - truth.x, auto.y - truth.y) * mmPerPx;
          errors[key].push(mm);
          cells.push(`${key} ${side}: ${mm.toFixed(1)}`);
        }
      }
      if (c.calibration.method === 'marker' && c.calibration.marker) {
        const m = autoDetectLandmarks(gray, { standardOrientation: c.standardOrientation, markerDiameterMm: c.calibration.markerDiameterMm });
        if (m.marker) markerErr.push((Math.abs(m.mmPerPx - mmPerPx) / mmPerPx) * 100);
      }
      perCase.push(`| ${f} | ${cells.join(' · ')} |`);
    }
    const lines = [
      '# Landmark detection accuracy',
      '',
      `${files.length} case file(s) in ${dir}`,
      '',
      '| Landmark | n | missed | median mm | 90th pct mm | within 2 mm | within 5 mm |',
      '| --- | --- | --- | --- | --- | --- | --- |',
      ...KEYS.map((k) => {
        const e = errors[k];
        if (!e.length) return `| ${k} | 0 | ${missed[k]} | — | — | — | — |`;
        const within = (t: number) => `${Math.round((e.filter((x) => x <= t).length / e.length) * 100)}%`;
        return `| ${k} | ${e.length} | ${missed[k]} | ${pct(e, 0.5).toFixed(1)} | ${pct(e, 0.9).toFixed(1)} | ${within(2)} | ${within(5)} |`;
      }),
      '',
      markerErr.length ? `Marker calibration error: median ${pct(markerErr, 0.5).toFixed(2)}% (n=${markerErr.length})` : '',
      '',
      '## Per case (mm)',
      '',
      '| Case | Errors |',
      '| --- | --- |',
      ...perCase,
    ];
    const report = lines.join('\n');
    writeFileSync(join(dir!, 'eval-report.md'), report);
    console.log(report);
  }, 600_000);
});
