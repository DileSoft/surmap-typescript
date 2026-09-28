import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { loadPalette, loadVmc, loadVmp, loadVpr, parseWorldConfig, type WorldConfig } from './loader';
import { renderPrepare } from './luts';
import { applyPaletteCycle, applyWaveCycle, buildPalette, type Palette } from './palette';
import { saveVmc, saveVmp } from './save';
import {
  loadC3D,
  projectionPreview,
  projectShape,
  type C3DModel,
  type ShapeOptions,
} from './shape';
import { VrtMap } from './vmap';
import { Viewer, type DebugMode, type EditTool, type RenderMode } from './viewer/viewer';

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

/** Triggers a browser download of a byte buffer. */
function downloadBytes(bytes: Uint8Array, name: string): void {
  const blob = new Blob([bytes as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Merges palette lists by file name (new entries win), preserving order. */
function mergePalettes(base: PaletteFile[], added: PaletteFile[]): PaletteFile[] {
  const map = new Map<string, PaletteFile>();
  for (const p of base) map.set(p.name.toLowerCase(), p);
  for (const p of added) map.set(p.name.toLowerCase(), p);
  return [...map.values()];
}

/** Round "?" icon that reveals a tooltip on hover/focus. */
function Hint({ children }: { children: ReactNode }) {
  return (
    <span className="tip" tabIndex={0}>
      <span className="tip-icon" aria-hidden="true">
        ?
      </span>
      <span className="tip-pop">{children}</span>
    </span>
  );
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

  const [editTool, setEditTool] = useState<EditTool>('off');
  const [editRadius, setEditRadius] = useState(32);
  const [editStrength, setEditStrength] = useState(8);
  const [editSmooth, setEditSmooth] = useState(5);
  const [saveFormat, setSaveFormat] = useState<'vmc' | 'vmp'>('vmp');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const [shapeModel, setShapeModel] = useState<C3DModel | null>(null);
  const [shapeMode, setShapeMode] = useState(0);
  const [shapeLevel, setShapeLevel] = useState(128);
  const [shapeSide, setShapeSide] = useState<'up' | 'down'>('up');
  const [shapeInverse, setShapeInverse] = useState(false);
  const [shapeNoiseLevel, setShapeNoiseLevel] = useState(0);
  const [shapeNoiseAmp, setShapeNoiseAmp] = useState(8);
  const [shapeYaw, setShapeYaw] = useState(0);
  const [shapePitch, setShapePitch] = useState(0);
  const [shapeRoll, setShapeRoll] = useState(0);
  const [shapeScale, setShapeScale] = useState(1);
  const [shapeScaleZ, setShapeScaleZ] = useState(1);
  const placeShapeRef = useRef<(x: number, y: number) => void>(() => {});

  const shapeOpts = useMemo<ShapeOptions | null>(() => {
    if (!shapeModel) return null;
    const d = Math.PI / 180;
    return {
      yaw: shapeYaw * d,
      pitch: shapePitch * d,
      roll: shapeRoll * d,
      scaleX: shapeScale,
      scaleY: shapeScale,
      scaleZ: shapeScaleZ,
      level: shapeLevel,
      mode: shapeMode,
      inverse: shapeInverse,
      side: shapeSide === 'down',
      noiseLevel: shapeNoiseLevel,
      noiseAmp: shapeNoiseAmp,
    };
  }, [
    shapeModel,
    shapeYaw,
    shapePitch,
    shapeRoll,
    shapeScale,
    shapeScaleZ,
    shapeLevel,
    shapeMode,
    shapeInverse,
    shapeSide,
    shapeNoiseLevel,
    shapeNoiseAmp,
  ]);

  const shapeInfo = useMemo(() => {
    if (!shapeModel || !shapeOpts) return null;
    const p = projectShape(shapeModel, shapeOpts, 0, 0);
    return { x: p.shapeX, y: p.shapeY, size: p.size };
  }, [shapeModel, shapeOpts]);

  const shapePreview = useMemo(() => {
    if (!shapeModel || !shapeOpts) return null;
    return projectionPreview(projectShape(shapeModel, shapeOpts, 0, 0), shapeOpts);
  }, [shapeModel, shapeOpts]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new Viewer(canvasRef.current, {
      onInfo: setInfo,
      onCursor: setCursor,
      onShapePlace: (x, y) => placeShapeRef.current(x, y),
      onHistoryChange: (u, r) => {
        setCanUndo(u);
        setCanRedo(r);
      },
    });
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

  // Push editor settings to the viewer.
  useEffect(() => {
    viewerRef.current?.setEdit({
      tool: editTool,
      radius: editRadius,
      strength: editStrength,
      smooth: editSmooth,
      smode: 0,
      equDelta: 5,
      shapeFootprint: shapeInfo,
      shapePreview: editTool === 'shape' ? shapePreview : null,
    });
  }, [editTool, editRadius, editStrength, editSmooth, shapeInfo, shapePreview]);

  /** Stamps the loaded 3D model at a clicked voxel. */
  function placeShape(x: number, y: number) {
    if (!map || !shapeModel || !shapeOpts) return;
    viewerRef.current?.stampShapeAt(shapeModel, shapeOpts, x, y);
    setStatus(`3D-модель вставлена в (${x},${y}), ${shapeInfo?.size ?? 0}×${shapeInfo?.size ?? 0}.`);
  }
  placeShapeRef.current = placeShape;

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y — undo/redo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA')) {
        return;
      }
      if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        if (e.shiftKey) viewerRef.current?.redo();
        else viewerRef.current?.undo();
      } else if (e.key === 'y' || e.key === 'Y') {
        e.preventDefault();
        viewerRef.current?.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);


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
    setSaveFormat(cfg.isCompressed ? 'vmc' : 'vmp');
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

  /** Saves the current (edited) surface as .vmc or .vmp. */
  function saveWorld() {
    if (!map || !config) return;
    try {
      setStatus('Сохранение...');
      const bytes = saveFormat === 'vmc' ? saveVmc(map) : saveVmp(map);
      const name = `${config.fileName || 'output'}.${saveFormat}`;
      downloadBytes(bytes, name);
      setStatus(`Сохранено: ${name} (${(bytes.length / 1048576).toFixed(1)} МБ).`);
    } catch (e) {
      console.error(e);
      setStatus('Ошибка сохранения: ' + (e as Error).message);
    }
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
          <Hint>
            Выберите в одном диалоге все файлы мира:
            <br />• <code>world.ini</code> — параметры мира (размер, палитра, цвета);
            <br />• <code>.vmp</code> (несжатый) или <code>.vmc</code> (сжатый) — рельеф;
            <br />• <code>.vpr</code> — уровень воды/сезонов;
            <br />• <code>.pal</code> — палитра (можно несколько, см. «цикл»).
            <br />
            Обычно лежат в папке мира, напр. <code>data/&lt;chain&gt;/&lt;world&gt;/</code>:
            <code>world.ini</code>, <code>output.vmc</code>, <code>output.vpr</code>,{' '}
            <code>harmony.pal</code>.
          </Hint>
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
          <Hint>
            Палитры-циклы (полная смена палитры): в игре лежат в{' '}
            <code>&lt;bin&gt;\resource\pal\</code>. У больших миров по три —
            <code>fostral.pal</code> / <code>fostral1.pal</code> / <code>fostral2.pal</code>
            (для Glorx/Necross аналогично: <code>glorx*</code>, <code>necross*</code>).
            <br />
            Каждый загруженный здесь <code>.pal</code> становится вариантом «цикла»; палитра из{' '}
            <code>world.ini</code> (<code>Palette File</code>) выбирается по умолчанию.
          </Hint>

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

        <div className="row">
          <span className="row-label">редактор</span>
          <label>
            инструмент
            <select
              value={editTool}
              onChange={(e) => setEditTool(e.target.value as EditTool)}
            >
              <option value="off">выкл</option>
              <option value="mountain">гора (+)</option>
              <option value="depression">впадина (−)</option>
              <option value="smooth">сгладить</option>
              <option value="shape">3D-модель</option>
            </select>
          </label>
          <label>
            радиус
            <input
              type="range"
              min={1}
              max={175}
              value={editRadius}
              disabled={editTool === 'off'}
              onChange={(e) => setEditRadius(Number(e.target.value))}
            />
            <span className="phase-val">{editRadius}</span>
          </label>
          <label>
            сила
            <input
              type="range"
              min={1}
              max={64}
              value={editStrength}
              disabled={editTool === 'off' || editTool === 'smooth'}
              onChange={(e) => setEditStrength(Number(e.target.value))}
            />
            <span className="phase-val">{editStrength}</span>
          </label>
          <label>
            сглаживание
            <input
              type="range"
              min={0}
              max={10}
              value={editSmooth}
              disabled={editTool === 'off'}
              onChange={(e) => setEditSmooth(Number(e.target.value))}
            />
            <span className="phase-val">{editSmooth}</span>
          </label>
          <button disabled={!map} onClick={() => viewerRef.current?.resetEdits()}>
            сбросить рельеф
          </button>
          <button disabled={!canUndo} onClick={() => viewerRef.current?.undo()} title="Ctrl+Z">
            ↶ undo
          </button>
          <button disabled={!canRedo} onClick={() => viewerRef.current?.redo()} title="Ctrl+Y">
            ↷ redo
          </button>
          <label>
            формат
            <select
              value={saveFormat}
              disabled={!map}
              onChange={(e) => setSaveFormat(e.target.value as 'vmc' | 'vmp')}
            >
              <option value="vmc">.vmc (сжатый)</option>
              <option value="vmp">.vmp (несжатый)</option>
            </select>
          </label>
          <button disabled={!map} onClick={saveWorld}>
            сохранить файл
          </button>
          <Hint>
            Выберите инструмент, затем <b>ЛКМ</b> — применить. Можно зажать и вести, как
            кистью: пока кнопка нажата, инструмент срабатывает повторно. <b>ПКМ</b> —
            панорама, колесо — зум.
            <br />
            <b>гора</b>/<b>впадина</b> приподнимают/опускают круг радиуса «радиус» на «силу»
            за клик; «сглаживание» задаёт плавность края (0 — ровный цилиндр, 10 — только
            склон). <b>сгладить</b> выравнивает рельеф по среднему.
            <br />
            «сбросить рельеф» возвращает загруженную карту высот и флаги.
            <br />
            «сохранить файл» выгружает текущий (отредактированный) рельеф: <code>.vmc</code>
            — сжатый, как в игре, или <code>.vmp</code> — несжатый. Имя берётся из{' '}
            <code>world.ini</code> (<code>File Name</code>).
          </Hint>
        </div>

        {editTool === 'shape' && (
        <div className="row">
          <span className="row-label">3D-модель</span>
          <label>
            файл (.c3d/.m3d)
            <input
              type="file"
              accept=".c3d,.m3d"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                void (async () => {
                  try {
                    const model = loadC3D(await readFile(f));
                    setShapeModel(model);
                    setEditTool('shape');
                    setStatus(
                      `${f.name}: ${model.numPoly} полигонов, ${model.numVert} вершин.`,
                    );
                  } catch (err) {
                    console.error(err);
                    setStatus('Ошибка модели: ' + (err as Error).message);
                  }
                })();
              }}
            />
          </label>
          <span className="phase-val" title="Размер отпечатка модели в вокселях">
            {shapeModel ? `${shapeInfo?.size ?? '—'}×${shapeInfo?.size ?? '—'}` : 'не загружена'}
          </span>
          <label>
            режим
            <select value={shapeMode} onChange={(e) => setShapeMode(Number(e.target.value))}>
              <option value={0}>map</option>
              <option value={1}>max</option>
              <option value={2}>min</option>
              <option value={3}>mean</option>
              <option value={4}>add</option>
            </select>
          </label>
          <label>
            уровень
            <input
              type="range"
              min={0}
              max={255}
              value={shapeLevel}
              onChange={(e) => setShapeLevel(Number(e.target.value))}
            />
            <span className="phase-val">{shapeLevel}</span>
          </label>
          <label>
            сторона
            <select
              value={shapeSide}
              onChange={(e) => setShapeSide(e.target.value as 'up' | 'down')}
            >
              <option value="up">верх</option>
              <option value="down">низ</option>
            </select>
          </label>
          <label>
            инверсия
            <input
              type="checkbox"
              checked={shapeInverse}
              onChange={(e) => setShapeInverse(e.target.checked)}
            />
          </label>
          <label>
            шум %
            <input
              type="range"
              min={0}
              max={100}
              value={shapeNoiseLevel}
              onChange={(e) => setShapeNoiseLevel(Number(e.target.value))}
            />
            <span className="phase-val">{shapeNoiseLevel}</span>
          </label>
          <label>
            амп
            <input
              type="range"
              min={0}
              max={64}
              value={shapeNoiseAmp}
              onChange={(e) => setShapeNoiseAmp(Number(e.target.value))}
            />
            <span className="phase-val">{shapeNoiseAmp}</span>
          </label>
          <label>
            поворот Z
            <input
              type="range"
              min={-180}
              max={180}
              value={shapeYaw}
              onChange={(e) => setShapeYaw(Number(e.target.value))}
            />
            <span className="phase-val">{shapeYaw}°</span>
          </label>
          <label>
            наклон X
            <input
              type="range"
              min={-180}
              max={180}
              value={shapePitch}
              onChange={(e) => setShapePitch(Number(e.target.value))}
            />
            <span className="phase-val">{shapePitch}°</span>
          </label>
          <label>
            крен Y
            <input
              type="range"
              min={-180}
              max={180}
              value={shapeRoll}
              onChange={(e) => setShapeRoll(Number(e.target.value))}
            />
            <span className="phase-val">{shapeRoll}°</span>
          </label>
          <label>
            масштаб XY
            <input
              type="range"
              min={0.05}
              max={4}
              step={0.05}
              value={shapeScale}
              onChange={(e) => setShapeScale(Number(e.target.value))}
            />
            <span className="phase-val">{shapeScale.toFixed(2)}</span>
          </label>
          <label>
            масштаб Z
            <input
              type="range"
              min={0.05}
              max={4}
              step={0.05}
              value={shapeScaleZ}
              onChange={(e) => setShapeScaleZ(Number(e.target.value))}
            />
            <span className="phase-val">{shapeScaleZ.toFixed(2)}</span>
          </label>
          <Hint>
            Загрузите <code>.c3d</code> или <code>.m3d</code> (в игре — папки{' '}
            <code>shape3d\</code> и <code>resource\m3d\</code>; <code>.m3d</code> начинается
            с той же модели, что и <code>.c3d</code>). Модель проецируется сверху в
            отпечаток, который штампуется в рельеф инструментом <b>«3D-модель»</b>{' '}
            (выбирается автоматически при загрузке).
            <br />
            Наведите на карту — пунктирный квадрат показывает отпечаток; <b>ЛКМ</b> —
            вставить. <b>режим</b>: map (заменить), max/min (только выше/ниже), mean
            (среднее), add (прибавить); <b>уровень</b> — сдвиг высоты; <b>сторона</b> — верх
            или низ модели; <b>инверсия</b> — вывернуть.
            <br />
            Поворот по Z/X/Y, масштаб XY/Z и шум применяются до вставки.
          </Hint>
        </div>
        )}
      </header>

      <div id="status">{status}</div>
      {info && <div id="info">{info}</div>}
      {cursor && <div id="cursor">{cursor}</div>}
      <div className="hint">
        {editTool === 'off'
          ? 'Колесо — зум, перетаскивание — панорама.'
          : 'ЛКМ — инструмент (зажать и вести), ПКМ — панорама, колесо — зум.'}
      </div>
      <canvas ref={canvasRef} id="view" width={1024} height={768} />
    </>
  );
}
