/**
 * Pan/zoom canvas viewer with draggable landmark handles.
 */
import type { Vec2 } from '../geometry/vec';
import type { Store, AppState, ReviewItem } from '../app/store';
import type { GrayImage } from '../imaging/gray';
import { intensityWindow } from '../imaging/gray';
import { drawOverlay, type Layers, type LabelLayer } from './overlay';
import { drawSummary, drawLegend } from './summary';
import { C as COLORS } from './overlay';
import { isOnImageLeft } from '../planning/measure';
import type { Side, StemPose } from '../planning/types';
import { fromFrame, toFrame, scale } from '../geometry/vec';
import { stemOutlineLocal, stemToFemur } from '../planning/plan';

interface Handle {
  pos: Vec2;
  move: (p: Vec2) => void;
  /** Called once when the drag ends (e.g. re-run detection). */
  done?: () => void;
}

export class Viewer {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private bitmap: HTMLCanvasElement | null = null;
  private bitmapSource: GrayImage | null = null;
  private bitmapWindow = '';
  private zoom = 1;
  /** Display rotation (rad) applied to the image; levels the teardrop line. */
  private rot = 0;
  /** Rotate the display so the inter-teardrop line is horizontal. */
  levelTeardrops = true;
  private tx = 0;
  private ty = 0;
  private drag: {
    kind: 'pan' | 'handle' | 'stem' | 'label' | 'summary';
    labelId?: string;
    labelStart?: Vec2;
    summaryStart?: { fx: number; top: number };
    start: Vec2;
    moved: boolean;
    handle?: Handle;
    origin?: { tx: number; ty: number };
    stemStart?: { femoral: Vec2; pose: StemPose };
  } | null = null;
  private hover: Vec2 | null = null;
  layers: Layers = { measurements: true, canal: false, cup: true, stem: true };
  /** Measurement labels the user dragged out of the way (offsets in CSS px). */
  labelLayer: LabelLayer = { offsets: {}, boxes: [] };
  summaryVisible = true;
  /** Summary box position: horizontal centre as a fraction of the width, top in CSS px. */
  private summaryPos = { fx: 0.5, top: 12 };
  private summaryBox: { x: number; y: number; w: number; h: number } | null = null;
  brightness = 0;
  contrast = 1;
  invert = false;

  constructor(
    private host: HTMLElement,
    private store: Store,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewer-canvas';
    host.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    new ResizeObserver(() => this.resize()).observe(host);
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => {
      this.hover = null;
      this.render();
    });
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    store.subscribe(() => {
      this.followReview();
      this.render();
    });
    this.resize();
  }

  private resize(): void {
    const r = this.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.render();
  }

  fit(): void {
    const img = this.store.state.image?.gray;
    if (!img) return;
    this.rot = this.targetRotation();
    const w = this.canvas.width;
    const h = this.canvas.height;
    const corners = [
      { x: 0, y: 0 },
      { x: img.width, y: 0 },
      { x: 0, y: img.height },
      { x: img.width, y: img.height },
    ].map((p) => this.rotateVec(p, this.rot));
    const minX = Math.min(...corners.map((p) => p.x));
    const maxX = Math.max(...corners.map((p) => p.x));
    const minY = Math.min(...corners.map((p) => p.y));
    const maxY = Math.max(...corners.map((p) => p.y));
    this.zoom = Math.min(w / (maxX - minX), h / (maxY - minY)) * 0.95;
    this.tx = (w - (maxX - minX) * this.zoom) / 2 - minX * this.zoom;
    this.ty = (h - (maxY - minY) * this.zoom) / 2 - minY * this.zoom;
    this.render();
  }

  private rotateVec(p: Vec2, a: number): Vec2 {
    const c = Math.cos(a);
    const sn = Math.sin(a);
    return { x: p.x * c - p.y * sn, y: p.x * sn + p.y * c };
  }

  /** Image px → screen (device) px. */
  private toScreen(p: Vec2): Vec2 {
    const r = this.rotateVec(p, this.rot);
    return { x: this.tx + r.x * this.zoom, y: this.ty + r.y * this.zoom };
  }

  /** Rotation that makes the inter-teardrop line horizontal (0 when off or unknown). */
  targetRotation(): number {
    // Level only once the landmarks are verified, so the image never turns
    // while points are still being placed or checked.
    if (!this.levelTeardrops || !this.store.landmarksVerified()) return 0;
    const { R, L } = this.store.state.case.landmarks;
    if (!R.teardrop || !L.teardrop) return 0;
    const [a, b] = R.teardrop.x < L.teardrop.x ? [R.teardrop, L.teardrop] : [L.teardrop, R.teardrop];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    return Math.abs(ang) < Math.PI / 6 ? -ang : 0;
  }

  /** Apply a new rotation while keeping the canvas centre fixed on the same image point. */
  private syncRotation(): void {
    const target = this.targetRotation();
    if (Math.abs(target - this.rot) < 1e-6) return;
    const c = { x: this.canvas.width / 2, y: this.canvas.height / 2 };
    const anchor = this.toImage(c);
    this.rot = target;
    const r = this.rotateVec(anchor, this.rot);
    this.tx = c.x - r.x * this.zoom;
    this.ty = c.y - r.y * this.zoom;
  }

  private lastReviewKey = '';

  /** Centre and zoom on the point currently under review. */
  private followReview(): void {
    const s = this.store.state;
    const item = this.store.currentReviewItem();
    const key = item ? (item.kind === 'marker' ? 'marker' : `${item.side}:${item.key}`) : '';
    if (key === this.lastReviewKey) return;
    this.lastReviewKey = key;
    if (!item || !s.image) return;
    const target = reviewTarget(s, item);
    if (!target) return;
    const mmPerPx = s.case.calibration?.mmPerPx ?? 0.15;
    const fieldPx = target.fieldMm / mmPerPx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.rot = this.targetRotation();
    this.zoom = Math.min(w, h) / fieldPx;
    const r = this.rotateVec(target.center, this.rot);
    this.tx = w / 2 - r.x * this.zoom;
    this.ty = h * 0.42 - r.y * this.zoom;
  }

  zoomBy(f: number): void {
    const c = { x: this.canvas.width / 2, y: this.canvas.height / 2 };
    this.zoomAt(c, f);
  }

  private zoomAt(screen: Vec2, f: number): void {
    const before = this.toImage(screen);
    this.zoom = Math.min(40, Math.max(0.02, this.zoom * f));
    const r = this.rotateVec(before, this.rot);
    this.tx = screen.x - r.x * this.zoom;
    this.ty = screen.y - r.y * this.zoom;
    this.render();
  }

  private screenPoint(e: MouseEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  }

  private toImage(p: Vec2): Vec2 {
    return this.rotateVec({ x: (p.x - this.tx) / this.zoom, y: (p.y - this.ty) / this.zoom }, -this.rot);
  }

  private handles(): Handle[] {
    const s = this.store.state;
    const hs: Handle[] = [];
    const recompute = () => this.store.recompute();
    for (const side of ['R', 'L'] as Side[]) {
      const l = s.case.landmarks[side];
      const pointHandle = (key: 'teardrop' | 'lesserTrochanter' | 'greaterTrochanter' | 'acetabularEdge') => {
        const p = l[key];
        if (p) hs.push({ pos: p, move: (q) => { l[key] = q; recompute(); } });
      };
      pointHandle('teardrop');
      pointHandle('lesserTrochanter');
      pointHandle('greaterTrochanter');
      pointHandle('acetabularEdge');
      if (l.head) {
        const head = l.head;
        hs.push({ pos: head.center, move: (q) => { head.center = q; recompute(); } });
        const edge = { x: head.center.x + head.radius, y: head.center.y };
        hs.push({
          pos: edge,
          move: (q) => {
            head.radius = Math.max(2, Math.hypot(q.x - head.center.x, q.y - head.center.y));
            recompute();
          },
        });
      }
      if (l.canalSeeds) {
        const seeds = l.canalSeeds;
        for (let i = 0; i < 2; i++) {
          hs.push({
            pos: seeds[i],
            move: (q) => {
              seeds[i] = q;
              this.render();
            },
            done: () => {
              this.store.detectCanal(side);
              recompute();
            },
          });
        }
      }
    }
    const plan = s.plan;
    const mmPerPx = s.case.calibration?.mmPerPx;
    if (plan?.cup && s.measurements && mmPerPx) {
      const pel = s.measurements.pelvis;
      hs.push({
        pos: scale(fromFrame(pel, plan.cup.center), 1 / mmPerPx),
        move: (q) => {
          s.case.options.cupCenter = toFrame(pel, scale(q, mmPerPx));
          recompute();
        },
      });
    }
    if (plan?.stem && plan.femur && mmPerPx) {
      const fem = plan.femur;
      const ch = plan.stem.chosen;
      const len = ch.size.profile[ch.size.profile.length - 1].d;
      hs.push({
        pos: scale(fromFrame(fem, stemToFemur(ch.pose, { x: 0, y: len })), 1 / mmPerPx),
        move: (q) => {
          const f = toFrame(fem, scale(q, mmPerPx));
          const v = { x: f.x - ch.pose.shift, y: f.y - ch.pose.depth };
          const tilt = (Math.atan2(-v.x, v.y) * 180) / Math.PI;
          this.store.setStemPose({ ...ch.pose, tilt: Math.max(-15, Math.min(15, tilt)) }, ch.size.size, ch.offset.id);
        },
      });
    }
    const cal = s.case.calibration;
    if (cal?.marker) {
      const mk = cal.marker;
      const d = cal.markerDiameterMm ?? 25;
      hs.push({ pos: { x: mk.center.x + mk.radius, y: mk.center.y }, move: (q) => {
        mk.radius = Math.max(2, Math.hypot(q.x - mk.center.x, q.y - mk.center.y));
        cal.mmPerPx = d / (2 * mk.radius);
        recompute();
      }, done: () => { this.store.redetectAll(); recompute(); } });
    }
    return hs;
  }

  private hitHandle(screen: Vec2): Handle | null {
    const dpr = window.devicePixelRatio || 1;
    const tol = 9 * dpr;
    let best: Handle | null = null;
    let bestD = tol;
    for (const h of this.handles()) {
      const sp = this.toScreen(h.pos);
      const d = Math.hypot(sp.x - screen.x, sp.y - screen.y);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  private hitLabel(screen: Vec2): string | null {
    const p = this.toImage(screen);
    for (let i = this.labelLayer.boxes.length - 1; i >= 0; i--) {
      const b = this.labelLayer.boxes[i];
      if (inRect(p, b)) return b.id;
    }
    return null;
  }

  resetLabels(): void {
    this.labelLayer.offsets = {};
    this.summaryPos = { fx: 0.5, top: 12 };
    this.render();
  }

  /** Image px → femoral frame (mm), if a plan with a femur exists. */
  private femoralPoint(img: Vec2): Vec2 | null {
    const s = this.store.state;
    const fem = s.plan?.femur;
    const mmPerPx = s.case.calibration?.mmPerPx;
    if (!fem || !mmPerPx) return null;
    return toFrame(fem, scale(img, mmPerPx));
  }

  /** If the screen point is inside the stem template, return the drag anchor. */
  private hitStem(screen: Vec2): { femoral: Vec2; pose: StemPose } | null {
    const s = this.store.state;
    const st = s.plan?.stem;
    const fem = s.plan?.femur;
    const mmPerPx = s.case.calibration?.mmPerPx;
    if (!st || !fem || !mmPerPx || !this.layers.stem) return null;
    const img = this.toImage(screen);
    const f = toFrame(fem, scale(img, mmPerPx));
    const poly = stemOutlineLocal(st.chosen.size, st.chosen.offset).map((q) => stemToFemur(st.chosen.pose, q));
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i];
      const b = poly[j];
      if (a.y > f.y !== b.y > f.y && f.x < ((b.x - a.x) * (f.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
    }
    return inside ? { femoral: f, pose: { ...st.chosen.pose } } : null;
  }

  private onDown(e: PointerEvent): void {
    if (!this.store.state.image) return;
    this.canvas.setPointerCapture(e.pointerId);
    const sp = this.screenPoint(e);
    if (e.button === 0 && this.summaryBox && inRect(sp, this.summaryBox)) {
      this.drag = { kind: 'summary', start: sp, moved: false, summaryStart: { ...this.summaryPos } };
      return;
    }
    const handle = e.button === 0 && !this.store.state.activeTool ? this.hitHandle(sp) : null;
    const lbl = !handle && e.button === 0 && !this.store.state.activeTool ? this.hitLabel(sp) : null;
    if (lbl) {
      this.drag = { kind: 'label', start: sp, moved: false, labelId: lbl, labelStart: { ...(this.labelLayer.offsets[lbl] ?? { x: 0, y: 0 }) } };
      return;
    }
    const stemHit = !handle && e.button === 0 && !this.store.state.activeTool ? this.hitStem(sp) : null;
    if (handle) this.drag = { kind: 'handle', start: sp, moved: false, handle };
    else if (stemHit) this.drag = { kind: 'stem', start: sp, moved: false, stemStart: stemHit };
    else this.drag = { kind: 'pan', start: sp, moved: false, origin: { tx: this.tx, ty: this.ty } };
  }

  private onMove(e: PointerEvent): void {
    const sp = this.screenPoint(e);
    this.hover = this.toImage(sp);
    if (!this.drag) {
      const overSummary = !!this.summaryBox && inRect(sp, this.summaryBox);
      this.canvas.style.cursor = overSummary ? 'move' : this.store.state.activeTool ? 'crosshair' : this.hitHandle(sp) || this.hitLabel(sp) || this.hitStem(sp) ? 'move' : 'grab';
      if (this.store.state.activeTool) this.render();
      return;
    }
    const dx = sp.x - this.drag.start.x;
    const dy = sp.y - this.drag.start.y;
    if (Math.hypot(dx, dy) > 3) this.drag.moved = true;
    if (this.drag.kind === 'pan' && this.drag.origin) {
      if (!this.drag.moved) return;
      this.tx = this.drag.origin.tx + dx;
      this.ty = this.drag.origin.ty + dy;
      this.canvas.style.cursor = 'grabbing';
      this.render();
    } else if (this.drag.kind === 'summary' && this.drag.summaryStart) {
      const dpr = window.devicePixelRatio || 1;
      this.summaryPos = {
        fx: Math.min(0.95, Math.max(0.05, this.drag.summaryStart.fx + dx / this.canvas.width)),
        top: Math.max(0, this.drag.summaryStart.top + dy / dpr),
      };
      this.render();
    } else if (this.drag.kind === 'label' && this.drag.labelId && this.drag.labelStart) {
      const dpr = window.devicePixelRatio || 1;
      this.labelLayer.offsets[this.drag.labelId] = { x: this.drag.labelStart.x + dx / dpr, y: this.drag.labelStart.y + dy / dpr };
      this.render();
    } else if (this.drag.kind === 'stem' && this.drag.moved && this.drag.stemStart) {
      const f = this.femoralPoint(this.toImage(sp));
      const st = this.drag.stemStart;
      const ch = this.store.state.plan?.stem?.chosen;
      if (f && ch) {
        this.store.setStemPose(
          { depth: st.pose.depth + (f.y - st.femoral.y), shift: st.pose.shift + (f.x - st.femoral.x), tilt: st.pose.tilt },
          ch.size.size,
          ch.offset.id,
        );
      }
    } else if (this.drag.handle && this.drag.moved) {
      this.drag.handle.move(this.toImage(sp));
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'handle' && d.moved) d.handle?.done?.();
    if (d.moved) this.render();
    if (d.kind === 'pan' && !d.moved && e.button === 0) {
      this.store.handleClick(this.toImage(this.screenPoint(e)));
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.zoomAt(this.screenPoint(e), Math.exp(-e.deltaY * 0.0015));
  }

  private ensureBitmap(s: AppState): void {
    const img = s.image?.gray;
    if (!img) {
      this.bitmap = null;
      return;
    }
    const win = s.window ?? s.image!.window ?? intensityWindow(img);
    const key = `${win[0]}|${win[1]}|${this.brightness}|${this.contrast}|${this.invert}`;
    if (this.bitmap && this.bitmapSource === img && this.bitmapWindow === key) return;
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const cx = c.getContext('2d')!;
    const id = cx.createImageData(img.width, img.height);
    const [lo, hi] = win;
    const scaleF = (255 / (hi - lo)) * this.contrast;
    for (let i = 0, j = 0; i < img.data.length; i++, j += 4) {
      let v = (img.data[i] - lo) * scaleF + this.brightness * 255 - (this.contrast - 1) * 127;
      v = Math.max(0, Math.min(255, v));
      if (this.invert) v = 255 - v;
      id.data[j] = id.data[j + 1] = id.data[j + 2] = v;
      id.data[j + 3] = 255;
    }
    cx.putImageData(id, 0, 0);
    this.bitmap = c;
    this.bitmapSource = img;
    this.bitmapWindow = key;
  }

  render(): void {
    const s = this.store.state;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05070a';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ensureBitmap(s);
    if (!this.bitmap) return;
    // Never rotate under the cursor: wait until any drag has finished.
    if (!this.drag) this.syncRotation();
    const zc = this.zoom * Math.cos(this.rot);
    const zs = this.zoom * Math.sin(this.rot);
    ctx.setTransform(zc, zs, -zs, zc, this.tx, this.ty);
    ctx.imageSmoothingEnabled = this.zoom < 2;
    ctx.drawImage(this.bitmap, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    this.labelLayer.textAngle = -this.rot;
    drawOverlay(ctx, s, dpr / this.zoom, this.layers, this.labelLayer);
    // Rubber-band preview for multi-click tools.
    if (this.hover && s.pendingClicks.length && s.activeTool) {
      const a = s.pendingClicks[s.pendingClicks.length - 1];
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth = dpr / this.zoom;
      ctx.setLineDash([4 / this.zoom, 4 / this.zoom]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(this.hover.x, this.hover.y);
      ctx.stroke();
      ctx.restore();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const opLeft = isOnImageLeft(s.case.operativeSide, s.case.standardOrientation);
    drawLegend(ctx, s, this.canvas.width, (opLeft ? 12 : 52) * dpr, dpr, COLORS, opLeft);
    this.summaryBox = this.summaryVisible && s.measurements ? drawSummary(ctx, s, this.summaryPos.fx * this.canvas.width, this.summaryPos.top * dpr, dpr) : null;
  }

  /** Full-resolution export of the image with overlays, as a Blob. */
  exportBlob(type: 'image/png' | 'image/jpeg'): Promise<Blob | null> {
    const c = this.exportCanvas();
    if (!c) return Promise.resolve(null);
    return new Promise((resolve) => c.toBlob((b) => resolve(b), type, 0.92));
  }

  private exportCanvas(): HTMLCanvasElement | null {
    const s = this.store.state;
    this.ensureBitmap(s);
    if (!this.bitmap) return null;
    const rot = this.targetRotation();
    const bw = this.bitmap.width;
    const bh = this.bitmap.height;
    const cos = Math.abs(Math.cos(rot));
    const sin = Math.abs(Math.sin(rot));
    const c = document.createElement('canvas');
    c.width = Math.round(bw * cos + bh * sin);
    c.height = Math.round(bw * sin + bh * cos);
    const cx = c.getContext('2d')!;
    cx.fillStyle = '#000';
    cx.fillRect(0, 0, c.width, c.height);
    cx.save();
    cx.translate(c.width / 2, c.height / 2);
    cx.rotate(rot);
    cx.translate(-bw / 2, -bh / 2);
    cx.drawImage(this.bitmap, 0, 0);
    const u = Math.max(1, c.width / 1400);
    drawOverlay(cx, s, u, this.layers, { offsets: this.labelLayer.offsets, boxes: [], textAngle: -rot });
    cx.restore();
    if (this.summaryVisible && s.measurements) drawSummary(cx, s, c.width / 2, 12 * u, u);
    drawLegend(cx, s, c.width, 12 * u, u, COLORS, isOnImageLeft(s.case.operativeSide, s.case.standardOrientation));
    return c;
  }

  /** Full-resolution export of the image with overlays, as a data URL. */
  exportImage(type: 'image/png' | 'image/jpeg' = 'image/png'): string | null {
    return this.exportCanvas()?.toDataURL(type, 0.92) ?? null;
  }

}

/** Where to look for a review item, and how much of the image to show (mm). */
export function reviewTarget(s: AppState, item: ReviewItem): { center: Vec2; fieldMm: number } | null {
  if (item.kind === 'marker') {
    const m = s.case.calibration?.marker;
    return m ? { center: m.center, fieldMm: 90 } : null;
  }
  const l = s.case.landmarks[item.side];
  switch (item.key) {
    case 'head':
      return l.head ? { center: l.head.center, fieldMm: 130 } : null;
    case 'canal':
      return l.canalSeeds
        ? { center: { x: (l.canalSeeds[0].x + l.canalSeeds[1].x) / 2, y: (l.canalSeeds[0].y + l.canalSeeds[1].y) / 2 }, fieldMm: 210 }
        : null;
    case 'teardrop':
      return l.teardrop ? { center: l.teardrop, fieldMm: 90 } : null;
    case 'lesserTrochanter':
      return l.lesserTrochanter ? { center: l.lesserTrochanter, fieldMm: 100 } : null;
    case 'acetabularEdge':
      return l.acetabularEdge ? { center: l.acetabularEdge, fieldMm: 90 } : null;
    case 'greaterTrochanter':
      return l.greaterTrochanter ? { center: l.greaterTrochanter, fieldMm: 100 } : null;
  }
}

function inRect(p: Vec2, r: { x: number; y: number; w: number; h: number }): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}
