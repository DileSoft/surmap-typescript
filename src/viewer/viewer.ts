/**
 * Canvas viewer for a rendered VrtMap. Framework-agnostic: owns the canvas,
 * draws the palette-indexed surface and handles zoom/pan/cursor. React only
 * drives it through its public methods and callbacks.
 */
import { DOUBLE_LEVEL, OBJSHADOW, SHADOW_MASK, TERRAIN_MASK, TERRAIN_OFFSET } from '../constants';
import type { Palette } from '../palette';
import type { VrtMap } from '../vmap';

export type RenderMode = 'line' | 'reg';
export type DebugMode =
  | 'color'
  | 'heights'
  | 'double'
  | 'terrain'
  | 'shadow'
  | 'objshadow'
  | 'doublebits';

export interface ViewerCallbacks {
  onInfo?: (text: string) => void;
  onCursor?: (text: string) => void;
}

export class Viewer {
  private map: VrtMap | null = null;
  private palette: Palette | null = null;
  private renderMode: RenderMode = 'reg';
  private debug: DebugMode = 'color';
  private tag = 0;
  private renderedRows = new Int16Array(0);

  scale = 1;
  offsetX = 0;
  offsetY = 0;

  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cb: ViewerCallbacks = {},
  ) {
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mouseleave', this.onMouseLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  dispose(): void {
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseleave', this.onMouseLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  setData(map: VrtMap, palette: Palette): void {
    this.map = map;
    this.palette = palette;
    this.renderedRows = new Int16Array(map.sizeY);
    this.tag = 0;
    this.fit();
  }

  setRenderMode(mode: RenderMode): void {
    if (this.renderMode === mode) return;
    this.renderMode = mode;
    // Undo the shadow edits of a previous regRender so LINE_render sees the
    // world's original (as-loaded) shadow bits.
    this.map?.resetMeta();
    this.tag++;
    this.draw();
  }

  setDebug(mode: DebugMode): void {
    this.debug = mode;
    this.draw();
  }

  /** Swaps the palette (e.g. after applying a Dynamic Palette cycle) and redraws. */
  setPalette(palette: Palette): void {
    this.palette = palette;
    this.draw();
  }

  fit(): void {
    if (!this.map) return;
    this.scale = Math.min(this.canvas.width / this.map.sizeX, this.canvas.height / this.map.sizeY);
    this.offsetX = 0;
    this.offsetY = 0;
    this.draw();
  }

  /** 1:1 — one voxel per screen pixel, centred on the current view. */
  oneToOne(): void {
    if (!this.map) return;
    const cx = this.offsetX + this.canvas.width / (2 * this.scale);
    const cy = this.offsetY + this.canvas.height / (2 * this.scale);
    this.scale = 1;
    this.offsetX = cx - this.canvas.width / 2;
    this.offsetY = cy - this.canvas.height / 2;
    this.clamp();
    this.draw();
  }

  screenToMap(px: number, py: number): { x: number; y: number } {
    return {
      x: Math.floor(this.offsetX + px / this.scale),
      y: Math.floor(this.offsetY + py / this.scale),
    };
  }

  zoomAt(px: number, py: number, factor: number): void {
    const before = this.screenToMap(px, py);
    this.scale = Math.max(0.05, Math.min(16, this.scale * factor));
    this.offsetX = before.x - px / this.scale;
    this.offsetY = before.y - py / this.scale;
    this.clamp();
    this.draw();
  }

  pan(dxPx: number, dyPx: number): void {
    this.offsetX -= dxPx / this.scale;
    this.offsetY -= dyPx / this.scale;
    this.clamp();
    this.draw();
  }

  draw(): void {
    const map = this.map;
    const palette = this.palette;
    if (!map || !palette) return;
    const ctx = this.canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const scale = this.scale;
    const y0 = Math.floor(this.offsetY);
    const y1 = Math.min(map.sizeY - 1, Math.floor(this.offsetY + this.canvas.height / scale));
    for (let y = y0; y <= y1; y++) this.ensureRow(y);

    const img = ctx.createImageData(this.canvas.width, this.canvas.height);
    const data = img.data;
    const rgba = palette.rgba;
    for (let py = 0; py < this.canvas.height; py++) {
      const my = (this.offsetY + py / scale) | 0;
      if (my < 0 || my >= map.sizeY) continue;
      const rowBase = py * this.canvas.width;
      for (let px = 0; px < this.canvas.width; px++) {
        const mx = (this.offsetX + px / scale) | 0;
        const idx = mx < 0 || mx >= map.sizeX ? 0 : this.sampleIndex(mx, my);
        const di = (rowBase + px) * 4;
        data[di] = rgba[idx * 4];
        data[di + 1] = rgba[idx * 4 + 1];
        data[di + 2] = rgba[idx * 4 + 2];
        data[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.cb.onInfo?.(this.infoText());
  }

  infoText(): string {
    return (
      `mode=${this.renderMode} view=${this.debug} ` +
      `scale=${this.scale.toFixed(2)} offset=(${this.offsetX.toFixed(0)},${this.offsetY.toFixed(0)})`
    );
  }

  private ensureRow(y: number): void {
    const map = this.map;
    if (!map || y < 0 || y >= map.sizeY) return;
    if (this.renderedRows[y] === this.tag + 1) return;
    if (this.renderMode === 'reg') map.regRender(0, y, map.sizeX - 1, y + 1);
    else map.lineRender(y);
    this.renderedRows[y] = this.tag + 1;
  }

  private sampleIndex(x: number, y: number): number {
    const map = this.map!;
    const base = y * map.sizeX + x;
    const h = map.height[base];
    const m = map.meta[base];
    switch (this.debug) {
      case 'color':
        return map.color[base];
      case 'heights':
        return (h >> 2) & 0xff;
      case 'double':
        return (((m & DOUBLE_LEVEL) ? 64 : 128) + (h >> 2)) & 0xff;
      case 'terrain':
        return (((m & TERRAIN_MASK) >> TERRAIN_OFFSET) * 32) & 0xff;
      case 'shadow':
        return m & SHADOW_MASK ? 255 : map.color[base];
      case 'objshadow':
        return m & OBJSHADOW ? 255 : map.color[base];
      case 'doublebits':
        return m & DOUBLE_LEVEL ? 255 : map.color[base];
    }
  }

  private clamp(): void {
    if (!this.map) return;
    const maxX = Math.max(0, this.map.sizeX - this.canvas.width / this.scale);
    const maxY = Math.max(0, this.map.sizeY - this.canvas.height / this.scale);
    this.offsetX = Math.max(0, Math.min(maxX, this.offsetX));
    this.offsetY = Math.max(0, Math.min(maxY, this.offsetY));
  }

  private onMouseDown = (e: MouseEvent) => {
    this.dragging = true;
    this.lastX = e.offsetX;
    this.lastY = e.offsetY;
  };

  private onMouseUp = () => {
    this.dragging = false;
  };

  private onMouseLeave = () => {
    this.dragging = false;
  };

  private onMouseMove = (e: MouseEvent) => {
    if (this.dragging) {
      this.pan(e.offsetX - this.lastX, e.offsetY - this.lastY);
      this.lastX = e.offsetX;
      this.lastY = e.offsetY;
      return;
    }
    this.cb.onCursor?.(this.describeCursor(e.offsetX, e.offsetY));
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.25 : 1 / 1.25);
  };

  private describeCursor(px: number, py: number): string {
    const map = this.map;
    if (!map) return '';
    const { x, y } = this.screenToMap(px, py);
    if (x < 0 || y < 0 || x >= map.sizeX || y >= map.sizeY) return '';
    const base = y * map.sizeX + x;
    const h = map.height[base];
    const m = map.meta[base];
    const terrain = (m & TERRAIN_MASK) >> TERRAIN_OFFSET;
    const flags =
      (m & DOUBLE_LEVEL ? 'D' : '') + (m & SHADOW_MASK ? 'S' : '') + (m & OBJSHADOW ? 'O' : '');
    return `x=${x} y=${y} h=${h} terrain=${terrain} flags=${flags || '-'}`;
  }
}
