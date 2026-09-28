/** Tiny INI parser matching the subset used by Vangers `world.ini` files. */

export type IniSection = Map<string, string>;
export type Ini = Map<string, IniSection>;

export function parseIni(text: string): Ini {
  const ini: Ini = new Map();
  let current: IniSection = new Map();
  ini.set('', current);

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith(';') || line.startsWith('#') || line.startsWith('//')) continue;

    const section = line.match(/^\[(.+?)\]$/);
    if (section) {
      current = new Map();
      ini.set(section[1].trim(), current);
      continue;
    }

    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    current.set(key, value);
  }
  return ini;
}

export function iniGet(ini: Ini, section: string, key: string): string | undefined {
  return ini.get(section)?.get(key);
}

export function iniGetInt(ini: Ini, section: string, key: string, def = 0): number {
  const v = iniGet(ini, section, key);
  if (v === undefined || v === '') return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

/** Parses whitespace/comma separated list of ints (`XBuffer >=` in the original). */
export function parseIntList(value: string | undefined, count: number, def = 0): number[] {
  const out = new Array<number>(count).fill(def);
  if (!value) return out;
  const parts = value.split(/[\s,]+/).filter((p) => p.length > 0);
  for (let i = 0; i < count && i < parts.length; i++) {
    const n = Number.parseInt(parts[i], 10);
    out[i] = Number.isFinite(n) ? n : def;
  }
  return out;
}
