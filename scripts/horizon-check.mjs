import assert from 'node:assert/strict';
import { loadModules } from './load.mjs';
const {mods:[D,M,R,B,G,S],close}=await loadModules(['/src/horizon/data.ts','/src/horizon/mesh.ts','/src/horizon/reduce.ts','/src/world/blocks.ts','/src/world/gen/generator.ts','/src/horizon/source.ts']);
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
  const tile=(level,x,z)=>({level,x,z,columns:Array.from({length:256},()=>new Uint32Array())});
  const parent=tile(1,-1,-1),children=[tile(0,-2,-2),tile(0,-2,-1),tile(0,-1,-2),tile(0,-1,-1)];
  const map=new Map(children.map(t=>[D.tileKey(t.level,t.x,t.z),t]));
  let ready=new Set([parent,...children.slice(0,3)]);
  const get=(l,x,z)=>map.get(D.tileKey(l,x,z));
  assert.deepEqual(D.selectTiles(parent,get,t=>ready.has(t),0,0),[parent]);
  ready.add(children[3]);assert.equal(D.selectTiles(parent,get,t=>ready.has(t),0,0).length,4);
  const merged=D.mergeTiles(children);assert.equal(merged.x,-1);assert.equal(merged.z,-1);
  assert.throws(()=>D.mergeTiles([children[0],children[0],children[2],children[3]]));
  const parentBase=tile(1,0,0);
  parentBase.columns=Array.from({length:256},()=>D.packColumn([span(0,8,1)]));
  const northWest=tile(0,0,0);
  northWest.columns=Array.from({length:256},()=>D.packColumn([span(0,8,2)]));
  const partial=D.mergeChildIntoParent(parentBase,northWest);
  for(let z=0;z<16;z++)for(let x=0;x<16;x++){
    const run=D.unpackColumn(partial.columns[z*16+x])[0];
    assert.equal(run.id,x<8&&z<8?2:1,'fine child must replace only its parent quadrant');
  }
  const southEast=tile(0,1,1);
  southEast.columns=Array.from({length:256},()=>D.packColumn([span(0,8,3)]));
  const twice=D.mergeChildIntoParent(partial,southEast);
  assert.equal(D.unpackColumn(twice.columns[15*16+15])[0].id,3);
  assert.equal(D.unpackColumn(twice.columns[15*16])[0].id,1,'unloaded parent quadrants must remain intact');
  assert.deepEqual(M.exposed(0,10,[span(2,4,1),span(7,12,1)]),[[0,2],[4,7]]);
  assert.equal(D.detailLevel(192),0);assert.equal(D.detailLevel(384),1);assert.equal(D.detailLevel(1536),3);
  const packedSample=[span(-64,320,0xffffffff,15,15),span(320,321,123,0,0)];
  assert.deepEqual(D.unpackColumn(D.packColumn(packedSample)),packedSample);
  const layered=Array.from({length:32},(_,i)=>span(i*3,i*3+2,i+1));
  const original=structuredClone(layered),reduced=R.reduceRenderColumn(layered,6);
  assert.ok(reduced.length<=6);assert.deepEqual(layered,original);
  assert.deepEqual(R.reduceRenderColumn(layered,1),[{...layered.at(-1),bottom:layered[0].bottom}]);
  for(let i=1;i<reduced.length;i++)assert.ok(reduced[i-1].top<=reduced[i].bottom);
  const sampleCalls=[];
  const sampledTile=S.captureGeneratedTile(-2,3,2,{sampleLodColumn:(x,z)=>{
    sampleCalls.push([x,z]);return [{min:-64,max:0,state:1,biome:2,sky:15,block:0}];
  }});
  assert.equal(sampledTile.level,2);assert.equal(sampledTile.columns.length,256);
  assert.deepEqual(sampleCalls[0],[-126,194]);
  assert.deepEqual(sampleCalls.at(-1),[-66,254]);
  assert.deepEqual(D.unpackColumn(sampledTile.columns[0]),[span(-64,0,131073,15,0)]);
  const generator=new G.ChunkGenerator('horizon-lod-validation');
  const generated=generator.generate(-3,5);
  for(const [lx,lz] of [[0,0],[7,7],[15,15],[3,12]]){
    const wx=-3*16+lx,wz=5*16+lz;
    const runs=generator.sampleLodColumn(wx,wz);
    assert.ok(runs.length>0,'sampled generator column must contain terrain');
    assert.deepEqual(generator.sampleLodColumn(wx,wz),runs,'generator samples must be deterministic');
    assert.equal(runs[0].biome,generated.biomes[lz*16+lx],'far sample biome must match the full chunk biome');
    assert.equal(runs.at(-1).max,generator.firstFreeHeight(wx,wz),'sampled terrain surface must match the exact density/aquifer height');
    for(let i=0;i<runs.length;i++){
      assert.ok(runs[i].min<runs[i].max);
      if(i)assert.ok(runs[i-1].max<=runs[i].min,'sampled runs must be sorted and non-overlapping');
    }
  }
  const flat={level:0,x:0,z:0,columns:Array.from({length:256},()=>D.packColumn([span(0,10,1)]))};
  const mesh=M.meshTile(flat,()=>0xabcdef);
  assert.equal(mesh.length/7,24,'a solid rectangular tile must collapse to six quads');
  console.log('PASS: voxel reduction oracle; parent-quadrant propagation; generator biome parity and deterministic sampled runs; mesh and LOD selection');
} finally {await close();}
