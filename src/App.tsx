import { useEffect, useRef, useState } from 'react';
import { loadPalette, loadVmc, loadVmp, loadVpr, parseWorldConfig, type WorldConfig } from './loader';
import { renderPrepare } from './luts';
import { applyPaletteCycle, applyWaveCycle, buildPalette, type Palette } from './palette';
import { VrtMap } from './vmap';
import { Viewer, type DebugMode, type RenderMode } from './viewer/viewer';

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function readFile(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function pick(files: File[], ...exts: string[]): File | undefined {
  return files.find((f) => exts.some((e) => f.name.toLowerCase().endsWith(e)));
}

interface PaletteFile {
  name: string;
  bytes: Uint8Array;
}

async function readPalettes(files: File[]): Promise<PaletteFile[]> {
  const out: PaletteFile[] = [];
  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.pal')) out.push({ name: f.name, bytes: await readFile(f) });
  }
  return out;
}

/** Merges palette lists by file name (new entries win), preserving order. */
function mergePalettes(base: PaletteFile[], added: PaletteFile[]): PaletteFile[] {
  const map = new Map<string, PaletteFile>();
  for (const p of base) map.set(p.name.toLowerCase(), p);
  for (const p of added) map.set(p.name.toLowerCase(), p);
  return [...map.values()];
}

/** Shimmer = the per-frame palette animation (pal_iter0/1/2), applied statically. */
type ShimmerKind = 'none' | 'wave' | 'dyn' | 'all';
interface ShimmerMode {
  label: string;
  kind: ShimmerKind;
  index?: number;
}

function shimmerModes(config: WorldConfig | null): ShimmerMode[] {
  const list: ShimmerMode[] = [{ label: 'нет', kind: 'none' }];
  if (config) {
    const w = config.dynamicPalette.waveTerrain;
    if (w >= 0 && w < 8) list.push({ label: `волна: террейн ${w}`, kind: 'wave' });
    config.dynamicPalette.cycles.forEach((c, i) =>
      list.push({ label: `сдвиг ${i + 1}: террейн ${c.terrain}`, kind: 'dyn', index: i }),
    );
    if (list.length > 1) list.push({ label: 'всё вместе', kind: 'all' });
  }
  return list;
}

function applyShimmer(
  base: Palette,
  config: WorldConfig,
  mode: ShimmerMode,
  phase01: number,
): Palette {
  const { beginColors, endColors, dynamicPalette } = config;
  let palette = base;
  if (mode.kind === 'wave') {
    palette = applyWaveCycle(palette, dynamicPalette.waveTerrain, beginColors, endColors, phase01);
  } else if (mode.kind === 'dyn') {
    palette = applyPaletteCycle(
      palette,
      dynamicPalette.cycles[mode.index ?? 0],
      beginColors,
      endColors,
      phase01,
    );
  } else if (mode.kind === 'all') {
    palette = applyWaveCycle(palette, dynamicPalette.waveTerrain, beginColors, endColors, phase01);
    for (const c of dynamicPalette.cycles) {
      palette = applyPaletteCycle(palette, c, beginColors, endColors, phase01);
    }
  }
  return palette;
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const iniRef = useRef<HTMLInputElement>(null);
  const dataRef = useRef<HTMLInputElement>(null);
  const vprRef = useRef<HTMLInputElement>(null);
  const palRef = useRef<HTMLInputElement>(null);

  const [map, setMap] = useState<VrtMap | null>(null);
  const [status, setStatus] = useState(
    'Выберите файлы мира (world.ini, .vmp/.vmc, .vpr, .pal) в одном диалоге.',
  );
  const [info, setInfo] = useState('');
  const [cursor, setCursor] = useState('');
  const [renderMode, setRenderMode] = useState<RenderMode>('reg');
  const [debug, setDebug] = useState<DebugMode>('color');

  const [config, setConfig] = useState<WorldConfig | null>(null);
  // Palette files: each one is a selectable "cycle" (full palette swap).
  const [palettes, setPalettes] = useState<PaletteFile[]>([]);
  const [paletteSel, setPaletteSel] = useState(0);
  const [basePalette, setBasePalette] = useState<Palette | null>(null);

  const [shimmerSel, setShimmerSel] = useState(0);
  const [phase, setPhase] = useState(50);

  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new Viewer(canvasRef.current, { onInfo: setInfo, onCursor: setCursor });
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  // Re-apply shimmer whenever the base palette, cycle or phase changes.
  useEffect(() => {
    if (!viewerRef.current || !basePalette || !config) return;
    const mode = shimmerModes(config)[shimmerSel] ?? { label: 'нет', kind: 'none' as const };
    viewerRef.current.setPalette(applyShimmer(basePalette, config, mode, phase / 100));
  }, [basePalette, shimmerSel, phase, config]);

  async function buildAndShow(
    cfg: WorldConfig,
    dataBytes: Uint8Array,
    vprBytes: Uint8Array | null,
    paletteFiles: PaletteFile[],
    baseIndex: number,
  ) {
    setStatus('Декодирование...');
    await sleep(30);

    const t0 = performance.now();
    const level = cfg.isCompressed ? loadVmc(dataBytes, cfg) : loadVmp(dataBytes, cfg);
    const tDecode = performance.now() - t0;

    const flood = vprBytes ? loadVpr(vprBytes, cfg)[0] : 0;
    const palBytes = paletteFiles[baseIndex]?.bytes ?? new Uint8Array(768);
    const palette = buildPalette(palBytes, cfg.beginColors, cfg.endColors);
    const luts = renderPrepare(cfg.beginColors, cfg.endColors, flood);
    const nextMap = new VrtMap(level, luts);

    setMap(nextMap);
    setConfig(cfg);
    setPalettes(paletteFiles);
    setPaletteSel(baseIndex);
    setBasePalette(palette);
    setShimmerSel(0);
    setPhase(50);
    if (import.meta.env.DEV) {
      (window as unknown as { __map?: VrtMap }).__map = nextMap;
    }
    viewerRef.current?.setData(nextMap, palette);
    setStatus(`Готово: ${level.sizeX}x${level.sizeY}, декод ${tDecode.toFixed(0)} мс.`);
  }

  function selectPalette(index: number) {
    setPaletteSel(index);
    if (!config || !palettes[index]) return;
    setBasePalette(buildPalette(palettes[index].bytes, config.beginColors, config.endColors));
  }

  async function loadFromFiles(files: File[]) {
    try {
      const ini = pick(files, '.ini');
      const data = pick(files, '.vmc', '.vmp');
      const vpr = pick(files, '.vpr');
      if (!ini || !data) {
        setStatus('Нужны минимум world.ini и .vmp/.vmc.');
        return;
      }
      setStatus('Чтение файлов...');
      await sleep(0);

      const cfg = parseWorldConfig(new TextDecoder().decode(await readFile(ini)));
      const merged = mergePalettes(palettes, await readPalettes(files));
      let baseIndex = merged.findIndex(
        (p) => p.name.toLowerCase() === cfg.paletteFile.toLowerCase(),
      );
      if (baseIndex < 0) baseIndex = 0;

      await buildAndShow(cfg, await readFile(data), vpr ? await readFile(vpr) : null, merged, baseIndex);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка: ' + (e as Error).message);
    }
  }

  /** Loads/replaces cycle palettes without re-selecting the whole world. */
  async function addPalettes(files: File[]) {
    const added = await readPalettes(files);
    if (!added.length) return;
    const merged = mergePalettes(palettes, added);
    setPalettes(merged);

    if (!config) {
      setStatus('Палитры загружены. Теперь выберите файлы мира.');
      return;
    }
    const index = Math.min(paletteSel, merged.length - 1);
    setPaletteSel(index);
    setBasePalette(buildPalette(merged[index].bytes, config.beginColors, config.endColors));
    setStatus(`Палитр: ${merged.length}.`);
  }

  async function loadSeparately() {
    const files = [iniRef.current, dataRef.current, vprRef.current, palRef.current]
      .map((r) => Array.from(r?.files ?? []))
      .flat();
    await loadFromFiles(files);
  }

  const modeList = shimmerModes(config);

  return (
    <>
      <header>
        <div className="row">
          <span className="row-label">загрузка</span>
          <label className="primary">
            Файлы мира
            <input
              type="file"
              multiple
              accept=".ini,.txt,.vmp,.vmc,.vpr,.pal"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) void loadFromFiles(files);
              }}
            />
          </label>
          <details className="separately">
            <summary>Загрузить по отдельности</summary>
            <div className="sep-body">
              <label>
                world.ini <input ref={iniRef} type="file" accept=".ini,.txt" />
              </label>
              <label>
                data <input ref={dataRef} type="file" accept=".vmp,.vmc" />
              </label>
              <label>
                .vpr <input ref={vprRef} type="file" accept=".vpr" />
              </label>
              <label>
                .pal <input ref={palRef} type="file" accept=".pal" multiple />
              </label>
              <button onClick={() => void loadSeparately()}>Загрузить</button>
            </div>
          </details>
        </div>

        <div className="row">
          <span className="row-label">рендер</span>
          <label>
            режим
            <select
              value={renderMode}
              onChange={(e) => {
                const mode = e.target.value as RenderMode;
                setRenderMode(mode);
                viewerRef.current?.setRenderMode(mode);
              }}
            >
              <option value="reg">regRender (тени)</option>
              <option value="line">LINE_render</option>
            </select>
          </label>
          <label>
            вид
            <select
              value={debug}
              onChange={(e) => {
                const mode = e.target.value as DebugMode;
                setDebug(mode);
                viewerRef.current?.setDebug(mode);
              }}
            >
              <option value="color">цвет</option>
              <option value="heights">высоты</option>
              <option value="double">double level</option>
              <option value="terrain">террейн</option>
              <option value="shadow">SHADOW</option>
              <option value="objshadow">OBJSHADOW</option>
              <option value="doublebits">DOUBLE бит</option>
            </select>
          </label>
          <button disabled={!map} onClick={() => viewerRef.current?.fit()}>
            Fit
          </button>
          <button disabled={!map} onClick={() => viewerRef.current?.oneToOne()}>
            1:1
          </button>
        </div>

        <div className="row">
          <span className="row-label">мерцание / цикл</span>

          <label>
            цикл (палитра)
            <select
              value={paletteSel}
              disabled={palettes.length <= 1}
              onChange={(e) => selectPalette(Number(e.target.value))}
            >
              {palettes.length === 0 && <option>— палитры не загружены —</option>}
              {palettes.map((p, i) => (
                <option key={i} value={i}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            палитры (.pal)
            <input
              type="file"
              multiple
              accept=".pal"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = '';
                if (files.length) void addPalettes(files);
              }}
            />
          </label>
          <span className="hint-inline">
            обычно в игре: <code>&lt;bin&gt;\resource\pal\</code> — fostral.pal, fostral1.pal,
            fostral2.pal (Glorx/Necross аналогично; по 3 у больших миров)
          </span>

          <label>
            мерцание
            <select
              value={shimmerSel}
              disabled={modeList.length <= 1}
              onChange={(e) => setShimmerSel(Number(e.target.value))}
            >
              {modeList.map((m, i) => (
                <option key={i} value={i}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
          <label title="Положение мерцания (статически)">
            фаза
            <input
              type="range"
              min={0}
              max={100}
              value={phase}
              disabled={modeList[shimmerSel]?.kind === 'none'}
              onChange={(e) => setPhase(Number(e.target.value))}
            />
            <span className="phase-val">{phase}%</span>
          </label>
        </div>
      </header>

      <div id="status">{status}</div>
      {info && <div id="info">{info}</div>}
      {cursor && <div id="cursor">{cursor}</div>}
      <div className="hint">Колесо — зум, перетаскивание — панорама.</div>
      <canvas ref={canvasRef} id="view" width={1024} height={768} />
    </>
  );
}
