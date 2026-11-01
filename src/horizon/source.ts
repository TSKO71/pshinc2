import { FLAGS, F_AIR } from '../world/block';
import { MIN_Y, MAX_Y } from '../world/constants';
import type { Chunk } from '../world/chunk';
import { packColumn, TILE_SIZE, type Tile, type Column } from './data';


/**
 * Generate a far tile directly from the world's density generator. Each LOD
 * column is sampled once at the centre of its represented block area, exactly
 * as the DH distant-generation path does, without producing full chunks.
 */
export function captureGeneratedTile(
  tileX: number,
  tileZ: number,
  level: number,
  generator: { sampleLodColumn(x: number, z: number): import('../world/gen/generator').LodSampleRun[] },
): Tile {
  const step = 2 ** level;
  const baseX = tileX * TILE_SIZE * step, baseZ = tileZ * TILE_SIZE * step;
  const columns: Uint32Array[] = new Array(TILE_SIZE * TILE_SIZE);
  for (let z = 0; z < TILE_SIZE; z++) {
    for (let x = 0; x < TILE_SIZE; x++) {
      const wx = baseX + x * step + Math.floor(step / 2);
      const wz = baseZ + z * step + Math.floor(step / 2);
      columns[z * TILE_SIZE + x] = packColumn(generator.sampleLodColumn(wx, wz).map(run => ({bottom:run.min,top:run.max,id:run.state+run.biome*65536,sky:run.sky,block:run.block})));
    }
  }
  return { level, x: tileX, z: tileZ, columns };
}

/**
 * Replace one 16x16 loaded chunk region inside its 64x64 level-zero DH tile.
 * The other 48x64 columns remain sourced from direct generator sampling.
 */
export function captureChunk(c: Chunk, base: Tile): Tile {
  const tileX = Math.floor(c.cx / 4), tileZ = Math.floor(c.cz / 4);
  if (base.level !== 0 || base.x !== tileX || base.z !== tileZ ||
      base.columns.length !== TILE_SIZE * TILE_SIZE) {
    throw new Error('Loaded chunk does not match its 64x64 base tile');
  }
  const columns = base.columns.slice();
  const offsetX = (c.cx - tileX * 4) * 16;
  const offsetZ = (c.cz - tileZ * 4) * 16;
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
    columns[(offsetZ + z) * TILE_SIZE + offsetX + x] = packColumn(out);
  }
  return { ...base, columns };
}
