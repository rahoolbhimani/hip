import { describe, it, expect } from 'vitest';
import { generatePhantom, sourcilGeometry } from '../src/imaging/synthetic';
import { autoDetectLandmarks } from '../src/imaging/autoLandmarks';
import type { Vec2 } from '../src/geometry/vec';

describe('automatic landmark proposals (phantom)', () => {
  const ph = generatePhantom({ mmPerPx: 0.3, noise: 5, lldMm: 6 });
  const r = autoDetectLandmarks(ph.image, { standardOrientation: true });
  const errMm = (p: Vec2 | undefined, truthMm: Vec2) => (p ? Math.hypot(p.x * ph.mmPerPx - truthMm.x, p.y * ph.mmPerPx - truthMm.y) : Infinity);

  it('finds the marker and calibrates without user input', () => {
    expect(r.marker).toBeDefined();
    expect(r.mmPerPx).toBeCloseTo(ph.mmPerPx, 2);
  });

  for (const side of ['R', 'L'] as const) {
    it(`proposes ${side} landmarks within 3 mm`, () => {
      const a = r.sides[side];
      const f = ph.femora[side];
      expect(errMm(a.head?.center, f.head)).toBeLessThan(1.5);
      expect(errMm(a.teardrop, ph.teardrops[side])).toBeLessThan(3);
      expect(errMm(a.lesserTrochanter, f.lesserTrochanter)).toBeLessThan(3);
      const roof = sourcilGeometry(f, side);
      expect(errMm(a.sourcil, roof.apex)).toBeLessThan(2);
      expect(errMm(a.acetabularEdge, roof.lateralEnd)).toBeLessThan(4);
      expect(Math.abs((a.ilioischial?.x ?? 0) * ph.mmPerPx - (ph.teardrops[side].x + (side === 'R' ? 6 : -6)))).toBeLessThan(1.5);
      // Proximal canal seed on the shaft axis at the LT level.
      expect(errMm(a.canalSeeds?.[0], f.axisAtLT)).toBeLessThan(3);
    });
  }

  it('respects flipped orientation', () => {
    const flipped = autoDetectLandmarks(ph.image, { standardOrientation: false });
    expect(errMm(flipped.sides.L.head?.center, ph.femora.R.head)).toBeLessThan(1.5);
  });
});
