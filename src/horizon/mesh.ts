import type { Tile, Column } from './data';
/** Exposed portions of a vertical face, subtracting all opaque neighbour spans. */
export function exposed(bottom: number, top: number, neighbour: Column): [number, number][] {
  const result: [number, number][] = [];
  let y = bottom;
  for (const s of neighbour) {
    if (s.top <= y) continue;
    if (s.bottom >= top) break;
    if (s.bottom > y) result.push([y, Math.min(s.bottom, top)]);
    y = Math.max(y, s.top);
    if (y >= top) break;
  }
  if (y < top) result.push([y, top]);
  return result;
}
export function meshTile(tile: Tile, color: (id: number) => number): Float32Array {
  const vertices: number[] = [], step = 2 ** tile.level;
  const quad = (points: number[][], rgb: number, light: number, shade: number) => {
    for (const i of [0, 1, 2, 0, 2, 3]) vertices.push(...points[i], ((rgb >> 16) & 255) / 255 * shade, ((rgb >> 8) & 255) / 255 * shade, (rgb & 255) / 255 * shade, light);
  };
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const column = tile.columns[z * 16 + x];
    const x0 = x * step, x1 = x0 + step, z0 = z * step, z1 = z0 + step;
    for (let i = 0; i < column.length; i++) {
      const s = column[i], rgb = color(s.id), light = (s.sky * 16 + s.block);
      const b = s.bottom, t = s.top;
      if (!column[i + 1] || column[i + 1].bottom > t)
        quad([[x0,t,z0],[x0,t,z1],[x1,t,z1],[x1,t,z0]],rgb,light,1);
      if (!column[i - 1] || column[i - 1].top < b)
        quad([[x0,b,z0],[x1,b,z0],[x1,b,z1],[x0,b,z1]],rgb,light,.5);
      for (const [dx,dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx=x+dx,nz=z+dz;
        const neighbour = nx>=0&&nx<16&&nz>=0&&nz<16 ? tile.columns[nz*16+nx] : [];
        for (const [lo,hi] of exposed(b,t,neighbour)) {
          const p = dx<0 ? [[x0,lo,z0],[x0,lo,z1],[x0,hi,z1],[x0,hi,z0]] : dx>0 ? [[x1,lo,z1],[x1,lo,z0],[x1,hi,z0],[x1,hi,z1]] : dz<0 ? [[x1,lo,z0],[x0,lo,z0],[x0,hi,z0],[x1,hi,z0]] : [[x0,lo,z1],[x1,lo,z1],[x1,hi,z1],[x0,hi,z1]];
          quad(p,rgb,light,dx?.6:.8);
        }
      }
    }
  }
  return new Float32Array(vertices);
}
