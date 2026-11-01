import assert from 'node:assert/strict';
import { loadModules } from './load.mjs';
const {mods:[D,M],close}=await loadModules(['/src/horizon/data.ts','/src/horizon/mesh.ts']);
const span=(bottom,top,id,sky=15,block=0)=>({bottom,top,id,sky,block});
try {
  assert.deepEqual(D.mergeColumns([[span(0,5,1)],[],[],[]]),[span(0,5,1)]);
  assert.deepEqual(D.mergeColumns([[span(0,5,1,0)],[span(0,5,1,4)],[span(0,5,2,15)],[span(0,5,2,15)]]),[span(0,5,1,2)]);
  assert.deepEqual(D.mergeColumns([[span(0,2,1),span(5,7,2)],[],[],[]]),[span(0,2,1),span(5,7,2)]);
  // Independent per-voxel oracle, against interval-based production reducer.
  let seed=42;const random=()=>((seed=Math.imul(seed,1664525)+1013904223|0)>>>0)/2**32;
  for(let trial=0;trial<200;trial++){
    const vox=Array.from({length:4},()=>Array.from({length:32},()=>Math.floor(random()*4)));
    const cols=vox.map(v=>v.flatMap((id,y)=>id?[span(y,y+1,id,y%16,y%8)]:[]));
    const out=D.mergeColumns(cols);
    for(let y=0;y<32;y++){
      const counts=new Map();for(const v of vox)if(v[y])counts.set(v[y],(counts.get(v[y])??0)+1);
      let winner=0,best=0;for(const v of vox)if((counts.get(v[y])??0)>best){winner=v[y];best=counts.get(v[y]);}
      const result=out.find(s=>s.bottom<=y&&s.top>y);
      assert.equal(result?.id??0,winner);
      if(winner){assert.equal(result.sky,y%16);assert.equal(result.block,y%8);}
    }
  }
  const tile=(level,x,z)=>({level,x,z,columns:Array.from({length:256},()=>[])});
  const parent=tile(1,-1,-1),children=[tile(0,-2,-2),tile(0,-2,-1),tile(0,-1,-2),tile(0,-1,-1)];
  const map=new Map(children.map(t=>[D.tileKey(t.level,t.x,t.z),t]));
  let ready=new Set([parent,...children.slice(0,3)]);
  const get=(l,x,z)=>map.get(D.tileKey(l,x,z));
  assert.deepEqual(D.selectTiles(parent,get,t=>ready.has(t),0,0),[parent]);
  ready.add(children[3]);assert.equal(D.selectTiles(parent,get,t=>ready.has(t),0,0).length,4);
  const merged=D.mergeTiles(children);assert.equal(merged.x,-1);assert.equal(merged.z,-1);
  assert.throws(()=>D.mergeTiles([children[0],children[0],children[2],children[3]]));
  assert.deepEqual(M.exposed(0,10,[span(2,4,1),span(7,12,1)]),[[0,2],[4,7]]);
  assert.equal(D.detailLevel(192),0);assert.equal(D.detailLevel(384),1);assert.equal(D.detailLevel(1536),3);
  const flat={level:0,x:0,z:0,columns:Array.from({length:256},()=>[span(0,10,1)])};
  const mesh=M.meshTile(flat,()=>0xabcdef);
  assert.equal(mesh.length/7,24,'a solid rectangular tile must collapse to six quads');
  console.log('PASS: 200 voxel-oracle reductions; light isolation; air/cavities; atomic four-child replacement; negative coordinates; occlusion; distance levels');
} finally {await close();}
