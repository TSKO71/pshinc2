/* Derived from Distant Horizons, Copyright (C) 2020 James Seibel.
 * LGPL-3.0-only; see licenses/distant-horizons and docs/DISTANT_HORIZONS.md.
 * TypeScript adaptation: explicit fields instead of Java packed longs.
 */
export interface Span { bottom: number; top: number; id: number; block: number; sky: number }
export type Column = Span[]; // ascending Y, half-open intervals
export interface Tile { level: number; x: number; z: number; columns: Column[] }
export const tileKey = (level: number, x: number, z: number): string => `${level}:${x}:${z}`;

/** FullDataSourceV2.mergeInputTwoByTwoDataColumn and winning-ID lighting.
 * Air cannot outvote a visible material. Ties retain input order (X then Z).
 */
export function mergeColumns(columns: readonly Column[]): Column {
  if (columns.length !== 4) throw new Error('DH reduction requires four columns');
  const transitions = [...new Set(columns.flatMap(c => c.flatMap(s => [s.bottom, s.top])))].sort((a, b) => a - b);
  const indices = [0, 0, 0, 0], out: Column = [];
  for (let y = 0; y + 1 < transitions.length; y++) {
    const bottom = transitions[y], top = transitions[y + 1];
    const samples = columns.map((c, i) => {
      while (indices[i] < c.length && c[indices[i]].top <= bottom) indices[i]++;
      const s = c[indices[i]];
      return s && s.bottom <= bottom ? s : undefined;
    });
    let id = 0, best = 0;
    for (const s of samples) {
      if (!s?.id) continue;
      const count = samples.filter(v => v?.id === s.id).length;
      if (count > best) { id = s.id; best = count; }
    }
    if (!id) continue;
    const winning = samples.filter((s): s is Span => s?.id === id);
    const block = Math.trunc(winning.reduce((n, s) => n + s.block, 0) / winning.length);
    const sky = Math.trunc(winning.reduce((n, s) => n + s.sky, 0) / winning.length);
    const last = out[out.length - 1];
    if (last && last.top === bottom && last.id === id && last.block === block && last.sky === sky) last.top = top;
    else out.push({ bottom, top, id, block, sky });
  }
  return out;
}

/** FullData updates percolate exactly one detail level at a time. */
export function mergeTiles(children: readonly Tile[]): Tile {
  if (children.length !== 4) throw new Error('Four complete child tiles required');
  const level = children[0].level + 1;
  const x = Math.floor(children[0].x / 2), z = Math.floor(children[0].z / 2);
  for (const c of children) if (c.level !== level - 1 || Math.floor(c.x / 2) !== x || Math.floor(c.z / 2) !== z) throw new Error('Non-sibling tiles');
  const lookup = new Map(children.map(c => [`${c.x},${c.z}`, c]));
  if (lookup.size !== 4) throw new Error('Duplicate child');
  const at = (sx: number, sz: number): Column => lookup.get(`${x * 2 + (sx >> 4)},${z * 2 + (sz >> 4)}`)!.columns[(sz & 15) * 16 + (sx & 15)];
  const columns: Column[] = [];
  for (let cz = 0; cz < 16; cz++) for (let cx = 0; cx < 16; cx++)
    columns.push(mergeColumns([at(cx * 2, cz * 2), at(cx * 2, cz * 2 + 1), at(cx * 2 + 1, cz * 2), at(cx * 2 + 1, cz * 2 + 1)]));
  return { level, x, z, columns };
}

/** LodQuadTree.calcDetailLevelFromDistance, MEDIUM quality (12 chunks, base 2). */
export function detailLevel(distance: number): number {
  return Math.max(0, Math.min(7, Math.trunc(Math.log(Math.max(distance, 1) / (12 * 16)) / Math.log(2))));
}

/** LodQuadTree.onDetailLevelTooLow: replace a parent only after ALL children
 * can render. A partial replacement is never returned alongside its parent.
 */
export function selectTiles(tile: Tile, get: (l: number, x: number, z: number) => Tile | undefined,
  ready: (t: Tile) => boolean, camX: number, camZ: number): Tile[] {
  const width = 16 * 2 ** tile.level;
  const desired = detailLevel(Math.hypot(camX - (tile.x + .5) * width, camZ - (tile.z + .5) * width));
  if (tile.level > desired) {
    const selected: Tile[] = [];
    let complete = true;
    for (let x = 0; x < 2; x++) for (let z = 0; z < 2; z++) {
      const child = get(tile.level - 1, tile.x * 2 + x, tile.z * 2 + z);
      const descendants = child ? selectTiles(child, get, ready, camX, camZ) : [];
      if (!descendants.length) complete = false;
      selected.push(...descendants);
    }
    if (complete) return selected;
  }
  return ready(tile) ? [tile] : [];
}
