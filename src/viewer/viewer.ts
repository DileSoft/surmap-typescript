/**
 * Canvas viewer for a rendered VrtMap. Framework-agnostic: owns the canvas,
 * draws the palette-indexed surface and handles zoom/pan/cursor. React only
 * drives it through its public methods and callbacks.
 */
import { DOUBLE_LEVEL, OBJSHADOW, SHADOW_MASK } from '../constants';
import type { Palette } from '../palette';
import {
  projectShape,
  regionOf,
  stampProjection,
  type C3DModel,
  type ShapeOptions,
} from '../shape';
import type { Layer, VrtMap } from '../vmap';

export type RenderMode = 'line' | 'reg';
export type DebugMode =
  | 'color'
  | 'heights'
  | 'double'
  | 'terrain'
  | 'shadow'
  | 'objshadow'
  | 'doublebits';

/** Terrain editor tool, mirroring the SURMAP Toolzer modes + 3D shape stamp. */
export type EditTool = 'off' | 'mountain' | 'depression' | 'smooth' | 'shape';

export interface EditOptions {
  tool: EditTool;
  /** Brush radius in voxels (1..MAX_RADIUS). */
  radius: number;
  /** Height delta per click (mountain/depression). */
  strength: number;
  /** Smooth zone 0..10. */
  smooth: number;
  /** Rim distribution 0..2 (even / random / rotating). */
  smode: number;
  /** Smoothing threshold for the `smooth` tool. */
  equDelta: number;
  /** Material (`CurrentTerrain`) written to edited voxels; -1 keeps it. */
  material?: number;
  /** Footprint of the loaded 3D shape (for the placement preview). */
  shapeFootprint?: { x: number; y: number; size: number } | null;
  /** Translucent preview bitmap of the projected shape. */
  shapePreview?: {
    x: number;
    y: number;
    size: number;
    rgba: Uint8ClampedArray;
  } | null;
}

export interface ViewerCallbacks {
  onInfo?: (text: string) => void;
  onCursor?: (text: string) => void;
  onShapePlace?: (x: number, y: number) => void;
  onHistoryChange?: (canUndo: boolean, canRedo: boolean) => void;
}

interface HistoryEntry {
  lowX: number;
  lowY: number;
  hiX: number;
  hiY: number;
  w: number;
  h: number;
  height: Uint8Array;
  meta: Uint8Array;
}

/** Cap undo+redo memory so long editing sessions stay bounded. */
const HISTORY_BUDGET = 128 * 1024 * 1024;

type DragMode = 'none' | 'pan' | 'paint';

export class Viewer {
  private map: VrtMap | null = null;
  private palette: Palette | null = null;
  private renderMode: RenderMode = 'reg';
  private debug: DebugMode = 'color';
  private tag = 0;
  private renderedRows = new Int16Array(0);
  private lastImage: ImageData | null = null;

  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private historyBytes = 0;
  private previewSrc: EditOptions['shapePreview'] = null;
  private previewCanvas: HTMLCanvasElement | null = null;

  scale = 1;
  offsetX = 0;
  offsetY = 0;

  private drag: DragMode = 'none';
  private lastX = 0;
  private lastY = 0;

  private edit: EditOptions = {
    tool: 'off',
    radius: 32,
    strength: 8,
    smooth: 5,
    smode: 0,
    equDelta: 5,
    material: -1,
  };
  private hoverX = -1;
  private hoverY = -1;
  private paintTimer: number | null = null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly cb: ViewerCallbacks = {},
  ) {
    canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    canvas.addEventListener('mousemove', this.onMouseMove);
    canvas.addEventListener('mouseleave', this.onMouseLeave);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
    canvas.addEventListener('contextmenu', this.onContextMenu);
  }

  dispose(): void {
    this.stopPaintLoop();
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.canvas.removeEventListener('mousemove', this.onMouseMove);
    this.canvas.removeEventListener('mouseleave', this.onMouseLeave);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.canvas.removeEventListener('contextmenu', this.onContextMenu);
  }

  setData(map: VrtMap, palette: Palette): void {
    this.map = map;
    this.palette = palette;
    this.renderedRows = new Int16Array(map.sizeY);
    this.tag = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.historyBytes = 0;
    this.cb.onHistoryChange?.(false, false);
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

  /**
   * Switches the shown/edited layer (SURMAP `RenderingLayer`). Shadow bits of
   * the previous layer's render are reset, then the visible rows re-render.
   */
  setLayer(layer: Layer): void {
    if (!this.map || this.map.currentLayer === layer) return;
    this.map.setLayer(layer);
    this.map.resetMeta();
    this.tag++;
    this.draw();
  }

  /** Swaps the palette (e.g. after applying a Dynamic Palette cycle) and redraws. */
  setPalette(palette: Palette): void {
    this.palette = palette;
    this.draw();
  }

  setEdit(edit: EditOptions): void {
    this.edit = { ...edit };
    this.canvas.style.cursor = this.edit.tool === 'off' ? 'grab' : 'crosshair';
    if (edit.shapePreview !== this.previewSrc) {
      this.previewSrc = edit.shapePreview ?? null;
      this.rebuildPreview();
    }
    if (this.edit.tool === 'off') {
      this.drag = 'none';
      this.stopPaintLoop();
    }
    if (this.edit.tool === 'off' && this.hoverX >= 0) {
      this.hoverX = -1;
      this.hoverY = -1;
      this.draw();
    } else if (this.hoverX >= 0) {
      this.drawBrush(this.hoverX, this.hoverY);
    }
  }

  private rebuildPreview(): void {
    const src = this.previewSrc;
    if (!src) {
      this.previewCanvas = null;
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = src.size;
    canvas.height = src.size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = ctx.createImageData(src.size, src.size);
    img.data.set(src.rgba);
    ctx.putImageData(img, 0, 0);
    this.previewCanvas = canvas;
  }

  // --- undo / redo ---------------------------------------------------------

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry || !this.map) return;
    const redo = this.snapshotRegion(entry.lowX, entry.lowY, entry.hiX, entry.hiY);
    this.restoreRegion(entry);
    this.redoStack.push(redo);
    this.trimHistory();
    this.refreshRegion(entry.lowX, entry.lowY, entry.hiX, entry.hiY);
    this.cb.onHistoryChange?.(this.canUndo(), this.canRedo());
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry || !this.map) return;
    const undo = this.snapshotRegion(entry.lowX, entry.lowY, entry.hiX, entry.hiY);
    this.restoreRegion(entry);
    this.undoStack.push(undo);
    this.trimHistory();
    this.refreshRegion(entry.lowX, entry.lowY, entry.hiX, entry.hiY);
    this.cb.onHistoryChange?.(this.canUndo(), this.canRedo());
  }

  private pushHistory(lowX: number, lowY: number, hiX: number, hiY: number): void {
    if (!this.map) return;
    this.redoStack = [];
    this.undoStack.push(this.snapshotRegion(lowX, lowY, hiX, hiY));
    this.trimHistory();
    this.cb.onHistoryChange?.(this.canUndo(), this.canRedo());
  }

  private snapshotRegion(lowX: number, lowY: number, hiX: number, hiY: number): HistoryEntry {
    const map = this.map!;
    const w = hiX - lowX + 1;
    const h = hiY - lowY + 1;
    const height = new Uint8Array(w * h);
    const meta = new Uint8Array(w * h);
    const clipX = map.sizeX - 1;
    const clipY = map.sizeY - 1;
    for (let j = 0; j < h; j++) {
      const rowBase = ((lowY + j) & clipY) * map.sizeX;
      for (let i = 0; i < w; i++) {
        const idx = rowBase + ((lowX + i) & clipX);
        height[j * w + i] = map.height[idx];
        meta[j * w + i] = map.meta[idx];
      }
    }
    this.historyBytes += height.length + meta.length;
    return { lowX, lowY, hiX, hiY, w, h, height, meta };
  }

  private restoreRegion(entry: HistoryEntry): void {
    const map = this.map!;
    const clipX = map.sizeX - 1;
    const clipY = map.sizeY - 1;
    for (let j = 0; j < entry.h; j++) {
      const rowBase = ((entry.lowY + j) & clipY) * map.sizeX;
      for (let i = 0; i < entry.w; i++) {
        const idx = rowBase + ((entry.lowX + i) & clipX);
        map.height[idx] = entry.height[j * entry.w + i];
        map.meta[idx] = entry.meta[j * entry.w + i];
      }
    }
  }

  private trimHistory(): void {
    const size = (e: HistoryEntry) => e.height.length + e.meta.length;
    while (
      this.historyBytes > HISTORY_BUDGET ||
      this.undoStack.length + this.redoStack.length > 200
    ) {
      const drop = this.undoStack.shift() ?? this.redoStack.shift();
      if (!drop) break;
      this.historyBytes -= size(drop);
    }
  }

  /** Stamps the loaded 3D model at a voxel, recording history. */
  stampShapeAt(model: C3DModel, opts: ShapeOptions, x: number, y: number): void {
    const map = this.map;
    if (!map) return;
    const proj = projectShape(model, opts, x, y);
    const region = regionOf(proj);
    this.pushHistory(region.lowX, region.lowY, region.hiX, region.hiY);
    stampProjection(map, proj, opts, this.edit.material ?? -1);
    this.refreshRegion(region.lowX, region.lowY, region.hiX, region.hiY);
  }

  /** Undoes all terrain edits (heights + flags) and redraws. */
  resetEdits(): void {
    const map = this.map;
    if (!map) return;
    this.pushHistory(0, 0, map.sizeX - 1, map.sizeY - 1);
    map.resetAll();
    this.tag++;
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

  /**
   * Re-renders an inclusive voxel region with the current render mode and
   * redraws. Used after an edit so only the affected rows are recomputed.
   */
  refreshRegion(lowX: number, lowY: number, hiX: number, hiY: number): void {
    const map = this.map;
    if (!map) return;
    const ymask = map.sizeY - 1;
    for (let y = lowY; y <= hiY; y++) {
      const yy = y & ymask;
      if (map.currentLayer === 'down') map.regDownRender(lowX, yy, hiX + 1, yy + 1);
      else if (this.renderMode === 'reg') map.regRender(lowX, yy, hiX + 1, yy + 1);
      else map.lineRender(yy);
      this.renderedRows[yy] = this.tag + 1;
    }
    this.draw();
  }

  /** Applies the active edit tool at a screen position. */
  applyEditAt(px: number, py: number): void {
    const map = this.map;
    if (!map || this.edit.tool === 'off' || this.edit.tool === 'shape') return;
    const { x, y } = this.screenToMap(px, py);
    if (x < 0 || y < 0 || x >= map.sizeX || y >= map.sizeY) return;

    const rad = this.edit.radius;
    const dh =
      this.edit.tool === 'mountain'
        ? this.edit.strength
        : this.edit.tool === 'depression'
          ? -this.edit.strength
          : 0;
    const eql = this.edit.tool === 'smooth' ? this.edit.equDelta : 0;
    this.pushHistory(x - rad, y - rad, x + rad, y + rad);
    map.deltaZone(x, y, rad, this.edit.smooth, dh, this.edit.smode, eql, this.edit.material ?? -1);
    this.refreshRegion(x - rad, y - rad, x + rad, y + rad);
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
    this.lastImage = img;
    ctx.putImageData(img, 0, 0);
    this.cb.onInfo?.(this.infoText());
    if (this.edit.tool !== 'off' && this.hoverX >= 0) this.drawBrush(this.hoverX, this.hoverY);
  }

  infoText(): string {
    return (
      `mode=${this.renderMode} layer=${this.map?.currentLayer ?? 'up'} view=${this.debug} ` +
      `scale=${this.scale.toFixed(2)} offset=(${this.offsetX.toFixed(0)},${this.offsetY.toFixed(0)})`
    );
  }

  private ensureRow(y: number): void {
    const map = this.map;
    if (!map || y < 0 || y >= map.sizeY) return;
    if (this.renderedRows[y] === this.tag + 1) return;
    if (map.currentLayer === 'down') map.regDownRender(0, y, map.sizeX - 1, y + 1);
    else if (this.renderMode === 'reg') map.regRender(0, y, map.sizeX - 1, y + 1);
    else map.lineRender(y);
    this.renderedRows[y] = this.tag + 1;
  }

  private sampleIndex(x: number, y: number): number {
    const map = this.map!;
    const base = y * map.sizeX + x;
    const h = map.getAlt(base, x);
    const m = map.meta[base];
    switch (this.debug) {
      case 'color':
        return map.color[base];
      case 'heights':
        return (h >> 2) & 0xff;
      case 'double':
        return (((m & DOUBLE_LEVEL) ? 64 : 128) + (h >> 2)) & 0xff;
      case 'terrain':
        return (map.getTerrain(base, x) * 32) & 0xff;
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

  /** Draws the brush outline for the current tool at a screen position. */
  private drawBrush(px: number, py: number): void {
    const map = this.map;
    if (!map || this.edit.tool === 'off' || !this.lastImage) return;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(this.lastImage, 0, 0);

    const { x, y } = this.screenToMap(px, py);

    ctx.save();
    ctx.lineWidth = 1;

    if (this.edit.tool === 'shape') {
      const pv = this.previewSrc;
      const fp = this.edit.shapeFootprint ?? pv;
      const sx = (x + (fp?.x ?? 0) - this.offsetX) * this.scale;
      const sy = (y + (fp?.y ?? 0) - this.offsetY) * this.scale;
      const sw = Math.max(1, (fp?.size ?? this.edit.radius * 2) * this.scale);
      if (pv && this.previewCanvas) {
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.globalAlpha = 0.75;
        ctx.drawImage(this.previewCanvas, sx, sy, sw, sw);
        ctx.restore();
      }
      ctx.strokeStyle = 'rgba(255,140,220,0.95)';
      ctx.strokeRect(sx, sy, sw, sw);
      ctx.beginPath();
      ctx.moveTo(sx + sw / 2 - 4, sy + sw / 2);
      ctx.lineTo(sx + sw / 2 + 4, sy + sw / 2);
      ctx.moveTo(sx + sw / 2, sy + sw / 2 - 4);
      ctx.lineTo(sx + sw / 2, sy + sw / 2 + 4);
      ctx.stroke();
      ctx.restore();
      return;
    }

    const cx = (x + 0.5 - this.offsetX) * this.scale;
    const cy = (y + 0.5 - this.offsetY) * this.scale;
    const r = Math.max(1, this.edit.radius * this.scale);

    ctx.strokeStyle =
      this.edit.tool === 'depression'
        ? 'rgba(90,170,255,0.95)'
        : this.edit.tool === 'smooth'
          ? 'rgba(140,240,140,0.95)'
          : 'rgba(255,220,80,0.95)';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 4, cy);
    ctx.lineTo(cx + 4, cy);
    ctx.moveTo(cx, cy - 4);
    ctx.lineTo(cx, cy + 4);
    ctx.stroke();
    ctx.restore();
  }

  private onMouseDown = (e: MouseEvent) => {
    if (e.button === 2 || (e.button === 0 && this.edit.tool === 'off')) {
      this.drag = 'pan';
      this.lastX = e.offsetX;
      this.lastY = e.offsetY;
      return;
    }
    if (e.button === 0 && this.edit.tool === 'shape') {
      const { x, y } = this.screenToMap(e.offsetX, e.offsetY);
      const map = this.map;
      if (map && x >= 0 && y >= 0 && x < map.sizeX && y < map.sizeY) {
        this.cb.onShapePlace?.(x, y);
      }
      return;
    }
    if (e.button === 0 && this.edit.tool !== 'off') {
      this.startPainting(e.offsetX, e.offsetY);
    }
  };

  private onMouseUp = () => {
    this.drag = 'none';
    this.stopPaintLoop();
  };

  private onMouseLeave = () => {
    this.drag = 'none';
    this.stopPaintLoop();
    if (this.hoverX >= 0) {
      this.hoverX = -1;
      this.hoverY = -1;
      if (this.edit.tool !== 'off') this.draw();
    }
  };

  private onMouseMove = (e: MouseEvent) => {
    this.hoverX = e.offsetX;
    this.hoverY = e.offsetY;

    if (this.drag === 'paint') {
      this.applyEditAt(e.offsetX, e.offsetY);
      return;
    }
    if (this.drag === 'pan') {
      this.pan(e.offsetX - this.lastX, e.offsetY - this.lastY);
      this.lastX = e.offsetX;
      this.lastY = e.offsetY;
      return;
    }
    if (this.edit.tool !== 'off') this.drawBrush(e.offsetX, e.offsetY);
    this.cb.onCursor?.(this.describeCursor(e.offsetX, e.offsetY));
  };

  /** Starts painting and keeps re-applying the tool while the button is held. */
  private startPainting(px: number, py: number): void {
    this.drag = 'paint';
    this.hoverX = px;
    this.hoverY = py;
    this.applyEditAt(px, py);
    this.stopPaintLoop();
    this.paintTimer = window.setInterval(() => {
      if (this.drag !== 'paint') {
        this.stopPaintLoop();
        return;
      }
      this.applyEditAt(this.hoverX, this.hoverY);
    }, 60);
  }

  private stopPaintLoop(): void {
    if (this.paintTimer !== null) {
      window.clearInterval(this.paintTimer);
      this.paintTimer = null;
    }
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.25 : 1 / 1.25);
  };

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault();
  };

  private describeCursor(px: number, py: number): string {
    const map = this.map;
    if (!map) return '';
    const { x, y } = this.screenToMap(px, py);
    if (x < 0 || y < 0 || x >= map.sizeX || y >= map.sizeY) return '';
    const base = y * map.sizeX + x;
    const h = map.getAlt(base, x);
    const m = map.meta[base];
    const terrain = map.getTerrain(base, x);
    const flags =
      (m & DOUBLE_LEVEL ? 'D' : '') + (m & SHADOW_MASK ? 'S' : '') + (m & OBJSHADOW ? 'O' : '');
    return `x=${x} y=${y} ${map.currentLayer}=${h} terrain=${terrain} flags=${flags || '-'}`;
  }
}
