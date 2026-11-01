import { FLAGS, F_AIR } from '../world/block';
import { MIN_Y, MAX_Y } from '../world/constants';
import type { Chunk } from '../world/chunk';
import type { Tile, Column } from './data';

/** Read the actual, decorated world, including cavities, foliage and structures. */
export function captureChunk(c: Chunk): Tile {
  const columns: Column[] = [];
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const out: Column = [];
    for (let y = MIN_Y; y < MAX_Y; y++) {
      const state = c.getState(x, y, z);
      if (FLAGS[state] & F_AIR) continue;
      const id = state + c.biomes[z * 16 + x] * 65536;
      const light = c.getLight(x, y + 1, z), sky = light >> 4, block = light & 15;
      const last = out[out.length - 1];
      if (last && last.top === y && last.id === id && last.sky === sky && last.block === block) last.top++;
      else out.push({ bottom: y, top: y + 1, id, sky, block });
    }
    columns.push(out);
  }
  return { level: 0, x: c.cx, z: c.cz, columns };
}
