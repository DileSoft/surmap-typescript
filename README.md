# surmap-typescript

Точный порт построения поверхности миров Vangers (VMP/VMC → **vmap** → `lineTcolor`)
на TypeScript, интерфейс — **Vite + React**, вывод — canvas. Реализация повторяет
оригинальный C++ из репозитория [KranX/Vangers](https://github.com/KranX/Vangers)
один-в-один, включая целочисленную фиксированную арифметику.

## Что портировано

| Компонент | Оригинал |
|---|---|
| INI-конфиг мира (`analyzeINI`) | `src/terra/vmap.cpp` |
| VMC Huffman-декодер (`InitSplay`/`ExpandBuffer`) | `src/terra/splay.cpp`, `src/terra/huff1.cpp`, `src/terra/compress.cpp` |
| VMP/VMC/VPR/palette загрузка (`load`, `LoadVPR`) | `src/terra/vmap.cpp` |
| LUT освещения и палитры (`RenderPrepare`) | `src/terra/land.cpp` |
| Базовый цвет поверхности (`LINE_render`) | `src/terra/land.cpp` |
| Тени поверхности (`regRender`: PreStage / MainStage / post) | `src/terra/siderend.cpp` |
| Палитра (`PalettePrepare`, `XGR_SetPal`) | `src/road.cpp` |

Не портировано (вне выбранного объёма): камера (`scaling`, `turning`, `scaling_3D`,
`PerpSlopTurn`/`SlopTurnSkip`), объекты, частицы, динамическая палитра (`pal_iter2`).

## Структура

```
src/
  constants.ts     битовые маски и константы (world.h/render.h/common.h)
  ini.ts           разбор world.ini
  huffman.ts       VMC-декодер (два дерева Хаффмана: дельта + XOR)
  loader.ts        VMP/VMC/VPR/palette
  luts.ts          RenderPrepare (lightCLR / palCLR)
  vmap.ts          VrtMap: LINE_render + regRender
  palette.ts       индекс палитры -> RGBA
  viewer/viewer.ts канвас-вьюер (ленивый рендер строк, зум/панорама)
  App.tsx          UI на React (файлы, режимы, кнопки)
  main.tsx         точка входа React
  style.css
index.html
vite.config.ts     React-плагин + раздача VANGERS_DATA под /@data/
test/
  loader.test.ts   Vitest: декод реального мира fostral, инварианты, PNG-превью
  debug-vmc.mjs    утилита разбора заголовка/таблиц VMC
```

## Сборка и запуск

```sh
npm install
npm run dev        # Vite dev-сервер, http://localhost:5173/
npm run build      # tsc --noEmit && vite build -> dist/
npm run preview    # предпросмотр production-сборки
npm test           # Vitest
npm run typecheck  # tsc --noEmit
```

### Данные мира
В браузере выберите `world.ini`, `output.vmp|vmc`, `output.vpr`, `harmony.pal`.

Либо отдайте каталог с данными Vangers и откройте автозагрузку. `vite.config.ts`
публикует `<VANGERS_DATA>` read-only под `/@data/`:

```powershell
$env:VANGERS_DATA='D:\...\Vangers\data'; npm run dev
# затем: http://localhost:5173/?data=/@data/thechain/fostral/
```

## Проверка

Vitest загружает `data/thechain/fostral`, декодирует 16384 строки VMC и проверяет,
что каждая строка потребляет **ровно** `sz_table[i]` байт (сильный инвариант
корректности Хаффман-декодера), затем рендерит поверхность и сверяет хэши:

| | color | meta |
|---|---|---|
| `LINE_render` (до `regRender`) | `fed77a5d` | — |
| `regRender` | `ac09fd4a` | `f65beb57` |

Хэши зафиксированы как регрессионный baseline. Превью пишутся в `test/out/`.
Те же значения воспроизводятся в браузере (проверено через `window.__map` в dev).

## Замечания по точности

- Вся арифметика целочисленная 32-битная; вместо `%` используется `& clip_mask`
  (`XCYCL`/`YCYCL`).
- **Смысл переключателя рендера.** `regRender` пересчитывает и перезаписывает
  биты `SHADOW`/`OBJSHADOW` в `meta`. `LINE_render` их только читает, поэтому
  после `regRender` он дал бы ту же картинку. Вьюер при смене режима вызывает
  `VrtMap.resetMeta()` и восстанавливает исходные (из файла) биты, чтобы
  `LINE_render` показывал затенение, записанное в самой карте.
- Горизонтальные «закольцованные» обращения к соседям сделаны через
  `x & (H_SIZE-1)`. В оригинале часть обращений (`*(pa+1)`, `*(pa-1)`) выходит за
  границы строки — это неопределённое поведение, которое не воспроизводится;
  визуально затрагивает только шов карты.
- Панель объектов палитры (`> ENDCOLOR[last]`, файл `objects.pal`) подставляется,
  только если передан соответствующий файл; для террейна нужны индексы
  `Begin..End Color`.
- Динамическая палитра (анимация воды/лавы, `pal_iter2`) не реализована —
  используется статичная палитра.
