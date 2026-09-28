# surmap-typescript

Точный порт построения поверхности миров Vangers (VMP/VMC → **vmap** → `lineTcolor`)
на TypeScript для браузера (canvas). Реализация повторяет оригинальный C++ из репозитория
[Vangers](https://github.com/caiiiycuk/Vangers) один-в-один, включая целочисленную
фиксированную арифметику.

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
  constants.ts   битовые маски и константы (world.h/render.h/common.h)
  ini.ts         разбор world.ini
  huffman.ts     VMC-декодер (два дерева Хаффмана: дельта + XOR)
  loader.ts      VMP/VMC/VPR/palette
  luts.ts        RenderPrepare (lightCLR / palCLR)
  vmap.ts        VrtMap: LINE_render + regRender
  palette.ts     индекс палитры -> RGBA
  main.ts        браузерный вьюер (ленивый рендер строк, зум/панорама)
index.html
test/
  loader.test.mjs  загрузка реального мира fostral, проверки и превью PNG
  debug-vmc.mjs    утилита разбора заголовка/таблиц VMC
```

## Сборка и запуск

```sh
npm install
npm run build          # tsc -> dist/

# вариант 1: выбрать файлы в браузере
npm run serve          # http://localhost:8080/

# вариант 2: отдать каталог с данными Vangers и открыть автозагрузку
# (PowerShell)
$env:VANGERS_DATA='D:\...\Vangers\data'; node server.mjs 8099
# затем: http://localhost:8099/?data=/@data/thechain/fostral/
```

Нужные файлы мира: `world.ini`, `output.vmp|vmc`, `output.vpr`, `harmony.pal`.

## Проверка

```sh
npm test
```

Тест загружает `data/thechain/fostral`, декодирует 16384 строки VMC и проверяет,
что каждая строка потребляет **ровно** `sz_table[i]` байт (сильный инвариант
корректности Хаффман-декодера), затем рендерит поверхность и пишет превью в
`test/out/`.

Результаты на fostral (hash = FNV-1a 32):

| | color | meta |
|---|---|---|
| `LINE_render` | `fed77a5d` | — |
| `regRender` | `ac09fd4a` | `f65beb57` |

Браузерный вьюер даёт **те же** хэши, что и Node-тест (совпадение проверено через
`window.__map`), т.е. canvas-вывод использует идентичный код.

## Замечания по точности

- Вся арифметика целочисленная 32-битная; вместо `%` используется `& clip_mask`
  (`XCYCL`/`YCYCL`).
- Горизонтальные «закольцованные» обращения к соседям сделаны через
  `x & (H_SIZE-1)`. В оригинале часть обращений (`*(pa+1)`, `*(pa-1)`) выходит за
  границы строки — это неопределённое поведение, которое не воспроизводится;
  визуально затрагивает только шов карты.
- Панель объектов палитры (`> ENDCOLOR[last]`, файл `objects.pal`) подставляется,
  только если передан соответствующий файл; для террейна нужны индексы
  `Begin..End Color`.
- Динамическая палитра (анимация воды/лавы, `pal_iter2`) не реализована —
  используется статичная палитра.
