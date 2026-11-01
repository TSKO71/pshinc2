/* Quad coalescing adapted from DH LodQuadBuilder.mergeQuads / BufferQuad.tryMerge.
 * Copyright (C) 2020 James Seibel and contributors; LGPL-3.0-only.
 */
import { reduceRenderColumn, verticalLimit } from './reduce';
import { unpackColumn, type Tile, type Column } from './data';
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
  const columns=tile.columns.map(c=>reduceRenderColumn(unpackColumn(c),verticalLimit(tile.level)));
  const vertices: number[] = [], step = 2 ** tile.level;
  type Rect = { u0:number;u1:number;v0:number;v1:number;axis:number;plane:number;rgb:number;light:number;shade:number };
  const groups = new Map<string,Rect[]>();
  const quad = (points: number[][], rgb: number, light: number, shade: number) => {
    const axis = [0,1,2].find(a=>points.every(p=>p[a]===points[0][a]))!;
    const u=axis===0?2:0,v=axis===1?2:1,plane=points[0][axis];
    const key=`${axis}:${plane}:${rgb}:${light}:${shade}`;
    let list=groups.get(key);if(!list)groups.set(key,list=[]);
    list.push({u0:Math.min(...points.map(p=>p[u])),u1:Math.max(...points.map(p=>p[u])),
      v0:Math.min(...points.map(p=>p[v])),v1:Math.max(...points.map(p=>p[v])),axis,plane,rgb,light,shade});
  };
  for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
    const column = columns[z * 16 + x];
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
        const neighbour = nx>=0&&nx<16&&nz>=0&&nz<16 ? columns[nz*16+nx] : [];
        for (const [lo,hi] of exposed(b,t,neighbour)) {
          const p = dx<0 ? [[x0,lo,z0],[x0,lo,z1],[x0,hi,z1],[x0,hi,z0]] : dx>0 ? [[x1,lo,z1],[x1,lo,z0],[x1,hi,z0],[x1,hi,z1]] : dz<0 ? [[x1,lo,z0],[x0,lo,z0],[x0,hi,z0],[x1,hi,z0]] : [[x0,lo,z1],[x1,lo,z1],[x1,hi,z1],[x0,hi,z1]];
          quad(p,rgb,light,dx?.6:.8);
        }
      }
    }
  }
  for(const list of groups.values()){
    list.sort((a,b)=>a.v0-b.v0||a.v1-b.v1||a.u0-b.u0);
    const rows:Rect[]=[];
    for(const r of list){const last=rows[rows.length-1];
      if(last&&last.v0===r.v0&&last.v1===r.v1&&last.u1===r.u0)last.u1=r.u1;
      else rows.push({...r});
    }
    // Like DH, only horizontal faces receive the second merge pass.
    let output=rows;
    if(rows[0]?.axis===1){
      rows.sort((a,b)=>a.u0-b.u0||a.u1-b.u1||a.v0-b.v0);output=[];
      for(const r of rows){const last=output[output.length-1];
        if(last&&last.u0===r.u0&&last.u1===r.u1&&last.v1===r.v0)last.v1=r.v1;
        else output.push({...r});
      }
    }
    for(const r of output)for(const [u,v] of [[r.u0,r.v0],[r.u0,r.v1],[r.u1,r.v1],[r.u1,r.v0]]){
      const p=r.axis===0?[r.plane,v,u]:r.axis===1?[u,r.plane,v]:[u,v,r.plane];
      vertices.push(...p,((r.rgb>>16)&255)/255*r.shade,((r.rgb>>8)&255)/255*r.shade,(r.rgb&255)/255*r.shade,r.light);
    }
  }
  return new Float32Array(vertices);
}
