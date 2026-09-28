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
| Циклы палитры (полная смена, «времена года») | `bunches.prm` (`cycleTable[i].pal_name`), `src/road.cpp` (`PalettePrepare`) |
| Мерцание палитры: волна на `Wave Terrain` | `src/palette.cpp` (`pal_iter0/1`) |
| Мерцание палитры: записи `Dynamic Palette` | `src/palette.cpp` (`pal_iter2`), `src/terra/vmap.cpp` (`analyzeINI`) |

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
vite.config.ts     конфиг Vite (react-плагин)
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

### Циклы и мерцание палитры
Это два разных механизма:

- **цикл (палитра)** — полная смена палитры. В игре это стадии банча
  (`bunches.prm`, поле `cycleTable[i].pal_name`): у больших миров
  **Fostral / Glorx / Necross по три** (`resource/pal/<world>.pal`,
  `<world>1.pal`, `<world>2.pal`), у остальных их нет. В вьюере циклом становится
  **каждый загруженный `.pal`**; палитра из `world.ini` (`Palette File`) выбирается
  по умолчанию (сопоставление по имени файла).
- **мерцание** — покадровая анимация палитры (`pal_iter0/1/2`), применённая
  статически: **волна** по диапазону `Wave Terrain` (обычно вода/лава),
  **сдвиг i** по записям `Dynamic Palette`, **всё вместе**. Ползунок «фаза»
  (0..100%) выбирает положение в цикле, не запуская времени.

### Данные мира
Всё работает целиком в браузере, без серверной загрузки. Нажмите «Файлы мира» и
выберите в одном диалоге сразу `world.ini`, `output.vmp|vmc`, `output.vpr` и
`harmony.pal` — файлы сопоставляются по расширению. При желании те же файлы можно
выбрать по отдельности в свёрнутом разделе «Загрузить по отдельности».

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
- И циклы (полная смена палитры), и мерцание (`pal_iter0/1/2`) воспроизводятся
  **статически**: выбирается палитра-цикл и положение мерцания (ползунок «фаза»),
  анимация по времени не запускается. Порядок мерцания как в игре: сначала волна
  (`pal_iter1`, перекрывающая `pal_iter0`), затем сдвиги `Dynamic Palette`
  (`pal_iter2`).
