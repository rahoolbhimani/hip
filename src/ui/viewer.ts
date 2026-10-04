/**
 * Pan/zoom canvas viewer with draggable landmark handles.
 */
import type { Vec2 } from '../geometry/vec';
import type { Store, AppState } from '../app/store';
import type { GrayImage } from '../imaging/gray';
import { intensityWindow } from '../imaging/gray';
import { drawOverlay, type Layers } from './overlay';
import type { Side } from '../planning/types';

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
  private tx = 0;
  private ty = 0;
  private drag: { kind: 'pan' | 'handle'; start: Vec2; moved: boolean; handle?: Handle; origin?: { tx: number; ty: number } } | null = null;
  private hover: Vec2 | null = null;
  layers: Layers = { measurements: true, canal: true, cup: true, stem: true };
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
    store.subscribe(() => this.render());
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
    const w = this.canvas.width;
    const h = this.canvas.height;
    this.zoom = Math.min(w / img.width, h / img.height) * 0.95;
    this.tx = (w - img.width * this.zoom) / 2;
    this.ty = (h - img.height * this.zoom) / 2;
    this.render();
  }

  zoomBy(f: number): void {
    const c = { x: this.canvas.width / 2, y: this.canvas.height / 2 };
    this.zoomAt(c, f);
  }

  private zoomAt(screen: Vec2, f: number): void {
    const before = this.toImage(screen);
    this.zoom = Math.min(40, Math.max(0.02, this.zoom * f));
    this.tx = screen.x - before.x * this.zoom;
    this.ty = screen.y - before.y * this.zoom;
    this.render();
  }

  private screenPoint(e: MouseEvent): Vec2 {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
  }

  private toImage(p: Vec2): Vec2 {
    return { x: (p.x - this.tx) / this.zoom, y: (p.y - this.ty) / this.zoom };
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
      const sx = h.pos.x * this.zoom + this.tx;
      const sy = h.pos.y * this.zoom + this.ty;
      const d = Math.hypot(sx - screen.x, sy - screen.y);
      if (d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  private onDown(e: PointerEvent): void {
    if (!this.store.state.image) return;
    this.canvas.setPointerCapture(e.pointerId);
    const sp = this.screenPoint(e);
    const handle = e.button === 0 && !this.store.state.activeTool ? this.hitHandle(sp) : null;
    if (handle) this.drag = { kind: 'handle', start: sp, moved: false, handle };
    else this.drag = { kind: 'pan', start: sp, moved: false, origin: { tx: this.tx, ty: this.ty } };
  }

  private onMove(e: PointerEvent): void {
    const sp = this.screenPoint(e);
    this.hover = this.toImage(sp);
    if (!this.drag) {
      this.canvas.style.cursor = this.store.state.activeTool ? 'crosshair' : this.hitHandle(sp) ? 'move' : 'grab';
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
    } else if (this.drag.handle && this.drag.moved) {
      this.drag.handle.move(this.toImage(sp));
    }
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'handle' && d.moved) d.handle?.done?.();
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
    ctx.setTransform(this.zoom, 0, 0, this.zoom, this.tx, this.ty);
    ctx.imageSmoothingEnabled = this.zoom < 2;
    ctx.drawImage(this.bitmap, 0, 0);
    const dpr = window.devicePixelRatio || 1;
    drawOverlay(ctx, s, dpr / this.zoom, this.layers);
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
  }

  /** Full-resolution export of the image with overlays. */
  exportPNG(): string | null {
    const s = this.store.state;
    this.ensureBitmap(s);
    if (!this.bitmap) return null;
    const c = document.createElement('canvas');
    c.width = this.bitmap.width;
    c.height = this.bitmap.height;
    const cx = c.getContext('2d')!;
    cx.drawImage(this.bitmap, 0, 0);
    drawOverlay(cx, s, Math.max(1, c.width / 1400), this.layers);
    return c.toDataURL('image/png');
  }
}
