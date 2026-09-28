/**
 * Browser viewer: loads a VMP/VMC world (+ VPR + palette) and draws the
 * rendered surface (LINE_render / regRender) to a canvas.
 *
 * Surface rows are rendered lazily on demand, so panning/zooming a huge world
 * (2048 x 16384) stays interactive.
 */
import {
  DOUBLE_LEVEL,
  OBJSHADOW,
  SHADOW_MASK,
  TERRAIN_MASK,
  TERRAIN_OFFSET,
} from './constants.js';
import { loadPalette, loadVmc, loadVmp, loadVpr, parseWorldConfig, type WorldConfig } from './loader.js';
import { renderPrepare } from './luts.js';
import { buildPalette, type Palette } from './palette.js';
import { VrtMap } from './vmap.js';

type RenderMode = 'line' | 'reg';
type DebugMode =
  | 'color'
  | 'heights'
  | 'double'
  | 'terrain'
  | 'shadow'
  | 'objshadow'
  | 'doublebits';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d', { alpha: false })!;
const status = document.getElementById('status') as HTMLDivElement;
const info = document.getElementById('info') as HTMLDivElement;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function readInput(input: HTMLInputElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const file = input.files?.[0];
    if (!file) return reject(new Error('no file selected'));
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

async function readOptional(input: HTMLInputElement): Promise<Uint8Array | null> {
  if (!input.files || input.files.length === 0) return null;
  return readInput(input);
}

class Viewer {
  private map: VrtMap | null = null;
  private palette: Palette | null = null;
  private renderMode: RenderMode = 'reg';
  private debug: DebugMode = 'color';
  private tag = 0;
  private renderedRows = new Int16Array(0);

  scale = 1;
  offsetX = 0;
  offsetY = 0;

  setData(map: VrtMap, palette: Palette) {
    this.map = map;
    this.palette = palette;
    this.renderedRows = new Int16Array(map.sizeY);
    this.tag = 0;
    this.scale = Math.min(canvas.width / map.sizeX, 1);
    this.offsetX = 0;
    this.offsetY = Math.max(0, (map.sizeY - canvas.height / this.scale) / 2);
    this.draw();
  }

  setRenderMode(mode: RenderMode) {
    if (this.renderMode === mode) return;
    this.renderMode = mode;
    this.tag++;
    this.draw();
  }

  setDebug(mode: DebugMode) {
    this.debug = mode;
    this.draw();
  }

  private ensureRow(y: number) {
    if (y < 0 || y >= this.map!.sizeY) return;
    if (this.renderedRows[y] === this.tag + 1) return;
    if (this.renderMode === 'reg') this.map!.regRender(0, y, this.map!.sizeX - 1, y + 1);
    else this.map!.lineRender(y);
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

  draw() {
    const map = this.map;
    const palette = this.palette;
    if (!map || !palette) return;

    const scale = this.scale;
    const x0 = Math.floor(this.offsetX);
    const y0 = Math.floor(this.offsetY);
    const x1 = Math.min(map.sizeX - 1, Math.floor(this.offsetX + canvas.width / scale));
    const y1 = Math.min(map.sizeY - 1, Math.floor(this.offsetY + canvas.height / scale));

    // Render all needed rows first (cheap when cached).
    for (let y = y0; y <= y1; y++) this.ensureRow(y);

    const img = ctx.createImageData(canvas.width, canvas.height);
    const data = img.data;
    const rgba = palette.rgba;
    for (let py = 0; py < canvas.height; py++) {
      const my = (this.offsetY + py / scale) | 0;
      if (my < 0 || my >= map.sizeY) continue;
      for (let px = 0; px < canvas.width; px++) {
        const mx = (this.offsetX + px / scale) | 0;
        let idx: number;
        if (mx < 0 || mx >= map.sizeX) idx = 0;
        else idx = this.sampleIndex(mx, my);
        const di = (py * canvas.width + px) * 4;
        data[di] = rgba[idx * 4];
        data[di + 1] = rgba[idx * 4 + 1];
        data[di + 2] = rgba[idx * 4 + 2];
        data[di + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    this.updateInfo();
  }

  updateInfo() {
    if (!this.map) return;
    info.textContent =
      `mode=${this.renderMode} view=${this.debug} ` +
      `scale=${this.scale.toFixed(2)} offset=(${this.offsetX.toFixed(0)},${this.offsetY.toFixed(0)})`;
  }

  screenToMap(px: number, py: number): { x: number; y: number } {
    return {
      x: Math.floor(this.offsetX + px / this.scale),
      y: Math.floor(this.offsetY + py / this.scale),
    };
  }

  zoomAt(px: number, py: number, factor: number) {
    const before = this.screenToMap(px, py);
    this.scale = Math.max(0.05, Math.min(16, this.scale * factor));
    this.offsetX = before.x - px / this.scale;
    this.offsetY = before.y - py / this.scale;
    this.clamp();
    this.draw();
  }

  pan(dxPx: number, dyPx: number) {
    this.offsetX -= dxPx / this.scale;
    this.offsetY -= dyPx / this.scale;
    this.clamp();
    this.draw();
  }

  fit() {
    if (!this.map) return;
    this.scale = Math.min(canvas.width / this.map.sizeX, canvas.height / this.map.sizeY);
    this.offsetX = 0;
    this.offsetY = 0;
    this.draw();
  }

  private clamp() {
    if (!this.map) return;
    const maxX = Math.max(0, this.map.sizeX - canvas.width / this.scale);
    const maxY = Math.max(0, this.map.sizeY - canvas.height / this.scale);
    this.offsetX = Math.max(0, Math.min(maxX, this.offsetX));
    this.offsetY = Math.max(0, Math.min(maxY, this.offsetY));
  }
}

const viewer = new Viewer();
let currentMap: VrtMap | null = null;

async function buildAndShow(
  iniText: string,
  dataBytes: Uint8Array,
  vprBytes: Uint8Array | null,
  palBytes: Uint8Array | null,
) {
  const config: WorldConfig = parseWorldConfig(iniText);

  status.textContent = `Декодирование (${config.isCompressed ? 'VMC' : 'VMP'})...`;
  await sleep(30);

  const t0 = performance.now();
  const level = config.isCompressed ? loadVmc(dataBytes, config) : loadVmp(dataBytes, config);
  const tDecode = performance.now() - t0;

  const flood = vprBytes ? loadVpr(vprBytes, config)[0] : 0;
  const palette = buildPalette(
    loadPalette(palBytes ?? new Uint8Array(768)),
    config.beginColors,
    config.endColors,
  );

  const luts = renderPrepare(config.beginColors, config.endColors, flood);
  const map = new VrtMap(level, luts);
  currentMap = map;
  (window as unknown as { __map: VrtMap }).__map = map;

  status.textContent = `Готово: ${level.sizeX}x${level.sizeY}, декод ${tDecode.toFixed(0)} мс.`;
  viewer.setData(map, palette);
  viewer.fit();
}

async function loadFromFiles() {
  try {
    const iniInput = $<HTMLInputElement>('ini');
    const dataInput = $<HTMLInputElement>('data');
    const vprInput = $<HTMLInputElement>('vpr');
    const palInput = $<HTMLInputElement>('pal');
    if (!iniInput.files?.length || !dataInput.files?.length) {
      status.textContent = 'Выберите world.ini и data (.vmp/.vmc) минимум.';
      return;
    }
    status.textContent = 'Чтение файлов...';
    await sleep(0);
    await buildAndShow(
      new TextDecoder().decode(await readInput(iniInput)),
      await readInput(dataInput),
      await readOptional(vprInput),
      await readOptional(palInput),
    );
  } catch (e) {
    console.error(e);
    status.textContent = 'Ошибка: ' + (e as Error).message;
  }
}

async function autoLoad(base: string) {
  try {
    status.textContent = `Автозагрузка из ${base}...`;
    const iniText = await (await fetch(base + 'world.ini')).text();
    const config = parseWorldConfig(iniText);
    const data = new Uint8Array(
      await (
        await fetch(base + `${config.fileName}.${config.isCompressed ? 'vmc' : 'vmp'}`)
      ).arrayBuffer(),
    );
    const vpr = await fetch(base + `${config.fileName}.vpr`)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? new Uint8Array(b) : null));
    const pal = await fetch(base + config.paletteFile)
      .then((r) => (r.ok ? r.arrayBuffer() : null))
      .then((b) => (b ? new Uint8Array(b) : null));
    await buildAndShow(iniText, data, vpr, pal);
  } catch (e) {
    console.error(e);
    status.textContent = 'Ошибка автозагрузки: ' + (e as Error).message;
  }
}

// --- UI wiring -------------------------------------------------------------
$('load').addEventListener('click', () => void loadFromFiles());
$('renderMode').addEventListener('change', (e) =>
  viewer.setRenderMode((e.target as HTMLSelectElement).value as RenderMode),
);
$('debug').addEventListener('change', (e) =>
  viewer.setDebug((e.target as HTMLSelectElement).value as DebugMode),
);
$('fit').addEventListener('click', () => viewer.fit());

let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.addEventListener('mousedown', (e) => {
  dragging = true;
  lastX = e.offsetX;
  lastY = e.offsetY;
});
window.addEventListener('mouseup', () => (dragging = false));
window.addEventListener('mousemove', (e) => {
  if (dragging) {
    viewer.pan(e.movementX, e.movementY);
    lastX = e.offsetX;
    lastY = e.offsetY;
    return;
  }
  const rect = canvas.getBoundingClientRect();
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  if (px >= 0 && py >= 0 && px < canvas.width && py < canvas.height && currentMap) {
    const { x, y } = viewer.screenToMap(px, py);
    if (x >= 0 && y >= 0 && x < currentMap.sizeX && y < currentMap.sizeY) {
      const base = y * currentMap.sizeX + x;
      const h = currentMap.height[base];
      const m = currentMap.meta[base];
      const terrain = (m & TERRAIN_MASK) >> TERRAIN_OFFSET;
      const flags =
        (m & DOUBLE_LEVEL ? 'D' : '') +
        (m & SHADOW_MASK ? 'S' : '') +
        (m & OBJSHADOW ? 'O' : '');
      $('cursor').textContent = `x=${x} y=${y} h=${h} terrain=${terrain} flags=${flags || '-'}`;
    }
  }
});
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    viewer.zoomAt(e.offsetX, e.offsetY, e.deltaY < 0 ? 1.25 : 1 / 1.25);
  },
  { passive: false },
);

status.textContent = 'Выберите файлы и нажмите «Загрузить».';

const autoData = new URLSearchParams(location.search).get('data');
if (autoData) {
  void autoLoad(autoData.endsWith('/') ? autoData : autoData + '/');
}
