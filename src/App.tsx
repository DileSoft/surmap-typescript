import { useEffect, useRef, useState } from 'react';
import { loadPalette, loadVmc, loadVmp, loadVpr, parseWorldConfig } from './loader';
import { renderPrepare } from './luts';
import { buildPalette } from './palette';
import { VrtMap } from './vmap';
import { Viewer, type DebugMode, type RenderMode } from './viewer/viewer';

const sleep = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function readInput(input: HTMLInputElement | null): Promise<Uint8Array | null> {
  const file = input?.files?.[0];
  if (!file) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const iniRef = useRef<HTMLInputElement>(null);
  const dataRef = useRef<HTMLInputElement>(null);
  const vprRef = useRef<HTMLInputElement>(null);
  const palRef = useRef<HTMLInputElement>(null);

  const [map, setMap] = useState<VrtMap | null>(null);
  const [status, setStatus] = useState('Выберите файлы и нажмите «Загрузить».');
  const [info, setInfo] = useState('');
  const [cursor, setCursor] = useState('');
  const [renderMode, setRenderMode] = useState<RenderMode>('reg');
  const [debug, setDebug] = useState<DebugMode>('color');

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
    if (import.meta.env.DEV) {
      (window as unknown as { __map?: VrtMap }).__map = nextMap;
    }
    viewerRef.current?.setData(nextMap, palette);
    setStatus(`Готово: ${level.sizeX}x${level.sizeY}, декод ${tDecode.toFixed(0)} мс.`);
  }

  async function loadFromFiles() {
    try {
      if (!iniRef.current?.files?.length || !dataRef.current?.files?.length) {
        setStatus('Выберите world.ini и data (.vmp/.vmc) минимум.');
        return;
      }
      setStatus('Чтение файлов...');
      await sleep(0);
      await buildAndShow(
        new TextDecoder().decode((await readInput(iniRef.current))!),
        (await readInput(dataRef.current))!,
        await readInput(vprRef.current),
        await readInput(palRef.current),
      );
    } catch (e) {
      console.error(e);
      setStatus('Ошибка: ' + (e as Error).message);
    }
  }

  // Auto-load when the page is opened as /?data=/@data/<world>/
  useEffect(() => {
    const base = new URLSearchParams(location.search).get('data');
    if (!base) return;
    const dir = base.endsWith('/') ? base : base + '/';
    (async () => {
      try {
        setStatus(`Автозагрузка из ${dir}...`);
        const iniText = await (await fetch(dir + 'world.ini')).text();
        const config = parseWorldConfig(iniText);
        const ext = config.isCompressed ? 'vmc' : 'vmp';
        const data = new Uint8Array(
          await (await fetch(dir + `${config.fileName}.${ext}`)).arrayBuffer(),
        );
        const vpr = await fetch(dir + `${config.fileName}.vpr`)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((b) => (b ? new Uint8Array(b) : null));
        const pal = await fetch(dir + config.paletteFile)
          .then((r) => (r.ok ? r.arrayBuffer() : null))
          .then((b) => (b ? new Uint8Array(b) : null));
        await buildAndShow(iniText, data, vpr, pal);
      } catch (e) {
        console.error(e);
        setStatus('Ошибка автозагрузки: ' + (e as Error).message);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <header>
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
        <button onClick={() => void loadFromFiles()}>Загрузить</button>

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
