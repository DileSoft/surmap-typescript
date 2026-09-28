import { useEffect, useRef, useState } from 'react';
import { loadPalette, loadVmc, loadVmp, loadVpr, parseWorldConfig, type WorldConfig } from './loader';
import { renderPrepare } from './luts';
import { applyPaletteCycle, buildPalette, type Palette, type PaletteCycle } from './palette';
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
  const [basePalette, setBasePalette] = useState<Palette | null>(null);
  const [cycles, setCycles] = useState<PaletteCycle[]>([]);
  const [cycleSel, setCycleSel] = useState(0); // 0 = original, i+1 = cycles[i]

  // Create the viewer once the canvas exists.
  useEffect(() => {
    if (!canvasRef.current) return;
    const viewer = new Viewer(canvasRef.current, { onInfo: setInfo, onCursor: setCursor });
    viewerRef.current = viewer;
    return () => {
      viewer.dispose();
      viewerRef.current = null;
    };
  }, []);

  async function buildAndShow(
    iniText: string,
    dataBytes: Uint8Array,
    vprBytes: Uint8Array | null,
    palBytes: Uint8Array | null,
  ) {
    setStatus('Декодирование...');
    await sleep(30);

    const config = parseWorldConfig(iniText);
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
    const nextMap = new VrtMap(level, luts);

    setMap(nextMap);
    setConfig(config);
    setBasePalette(palette);
    setCycles(config.dynamicPalette.cycles);
    setCycleSel(0);
    if (import.meta.env.DEV) {
      (window as unknown as { __map?: VrtMap }).__map = nextMap;
    }
    viewerRef.current?.setData(nextMap, palette);
    setStatus(`Готово: ${level.sizeX}x${level.sizeY}, декод ${tDecode.toFixed(0)} мс.`);
  }

  /** Applies the selected Dynamic Palette record statically (no animation). */
  function selectCycle(sel: number) {
    setCycleSel(sel);
    if (!basePalette || !config) return;
    const palette =
      sel === 0
        ? basePalette
        : applyPaletteCycle(basePalette, cycles[sel - 1], config.beginColors, config.endColors);
    viewerRef.current?.setPalette(palette);
  }

  /** Loads a world from an arbitrary set of selected files, matched by extension. */
  async function loadFromFiles(files: File[]) {
    try {
      const ini = pick(files, '.ini');
      const data = pick(files, '.vmc', '.vmp');
      const vpr = pick(files, '.vpr');
      const pal = pick(files, '.pal');

      if (!ini || !data) {
        setStatus('Нужны минимум world.ini и .vmp/.vmc.');
        return;
      }
      setStatus('Чтение файлов...');
      await sleep(0);
      await buildAndShow(
        new TextDecoder().decode(await readFile(ini)),
        await readFile(data),
        vpr ? await readFile(vpr) : null,
        pal ? await readFile(pal) : null,
      );
    } catch (e) {
      console.error(e);
      setStatus('Ошибка: ' + (e as Error).message);
    }
  }

  /** Button inside the collapsed "separately" section. */
  async function loadSeparately() {
    const files = [iniRef.current, dataRef.current, vprRef.current, palRef.current]
      .map((r) => r?.files?.[0])
      .filter((f): f is File => !!f);
    await loadFromFiles(files);
  }

  return (
    <>
      <header>
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
              .pal <input ref={palRef} type="file" accept=".pal" />
            </label>
            <button onClick={() => void loadSeparately()}>Загрузить</button>
          </div>
        </details>

        <label>
          рендер
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

        <label>
          цикл
          <select
            value={cycleSel}
            disabled={cycles.length === 0}
            onChange={(e) => selectCycle(Number(e.target.value))}
          >
            <option value={0}>оригинал</option>
            {cycles.map((c, i) => (
              <option key={i} value={i + 1}>
                {`цикл ${i + 1}: террейн ${c.terrain} (R${c.red} G${c.green} B${c.blue}, ампл ${c.ampl})`}
              </option>
            ))}
          </select>
        </label>

        <button disabled={!map} onClick={() => viewerRef.current?.fit()}>
          Fit
        </button>
        <button disabled={!map} onClick={() => viewerRef.current?.oneToOne()}>
          1:1
        </button>
      </header>

      <div id="status">{status}</div>
      {info && <div id="info">{info}</div>}
      {cursor && <div id="cursor">{cursor}</div>}
      <div className="hint">Колесо — зум, перетаскивание — панорама.</div>
      <canvas ref={canvasRef} id="view" width={1024} height={768} />
    </>
  );
}
