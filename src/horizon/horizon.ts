import { BUILD_ID } from '../net/config';
import { type Tile, tileKey, mergeTiles, mergeChildIntoParent, selectTiles, detailLevel } from './data';
import { captureChunk } from './source';
import { loadTile, saveTile } from './store';
import { HorizonRenderer } from './renderer';
import type { ChunkManager } from '../world/chunkManager';
import type { Chunk } from '../world/chunk';
import type { Job } from '../worker/pool';
import type { TerrainParams } from '../render/worldRenderer';
import type { GL } from '../render/gl';
import type { Atlas } from '../render/atlas';

function* coordinates(cx:number,cz:number,radiusChunks:number):Generator<[number,number,number]> {
  const playerX=cx*16+8,playerZ=cz*16+8,radius=radiusChunks*16,rootLevel=7;
  function* walk(level:number,x:number,z:number):Generator<[number,number,number]> {
    const width=16*2**level,minX=x*width,minZ=z*width;
    const dx=playerX<minX?minX-playerX:playerX>minX+width?playerX-(minX+width):0;
    const dz=playerZ<minZ?minZ-playerZ:playerZ>minZ+width?playerZ-(minZ+width):0;
    if(Math.max(dx,dz)>radius)return;
    const distance=Math.hypot(playerX-(minX+width/2),playerZ-(minZ+width/2));
    const desired=detailLevel(distance);
    if(level>desired&&level>0){
      const children:[number,number,number][]=[];
      for(let xSide=0;xSide<2;xSide++)for(let zSide=0;zSide<2;zSide++)children.push([level-1,x*2+xSide,z*2+zSide]);
      children.sort((a,b)=>{
        const wa=16*2**a[0],wb=16*2**b[0];
        return Math.hypot((a[1]+.5)*wa-playerX,(a[2]+.5)*wa-playerZ)-Math.hypot((b[1]+.5)*wb-playerX,(b[2]+.5)*wb-playerZ);
      });
      for(const child of children)yield* walk(child[0],child[1],child[2]);
    }else yield [level,x,z];
  }
  const width=16*2**rootLevel;
  const minX=Math.floor((playerX-radius)/width),maxX=Math.floor((playerX+radius)/width);
  const minZ=Math.floor((playerZ-radius)/width),maxZ=Math.floor((playerZ+radius)/width);
  const roots:[number,number][]=[];
  for(let x=minX;x<=maxX;x++)for(let z=minZ;z<=maxZ;z++)roots.push([x,z]);
  roots.sort((a,b)=>Math.hypot((a[0]+.5)*width-playerX,(a[1]+.5)*width-playerZ)-Math.hypot((b[0]+.5)*width-playerX,(b[1]+.5)*width-playerZ));

  // Collect the desired leaf plan, then first queue one coarser fallback
  // parent for every leaf. The renderer keeps that parent until all four
  // child branches are complete, so the horizon exists before fine work ends.
  const leaves:[number,number,number][]=[];
  for(const root of roots)for(const leaf of walk(rootLevel,root[0],root[1]))leaves.push(leaf);
  const leafKeys=new Set(leaves.map(t=>tileKey(t[0],t[1],t[2])));
  const parents=new Map<string,[number,number,number]>();
  for(const [level,x,z] of leaves)if(level<rootLevel){
    // Avoid hundreds of tiny fallback tiles near the player. A minimum
    // 128-block fallback (level 3) covers nearby regions first; fine data
    // later propagates through the intermediate levels as sibling sets fill.
    const fallbackLevel=Math.max(level+1,3);
    const scale=2**(fallbackLevel-level);
    const parent:[number,number,number]=[fallbackLevel,Math.floor(x/scale),Math.floor(z/scale)];
    const key=tileKey(parent[0],parent[1],parent[2]);
    if(!leafKeys.has(key))parents.set(key,parent);
  }
  const distance=(t:[number,number,number])=>{
    const w=16*2**t[0];return Math.hypot((t[1]+.5)*w-playerX,(t[2]+.5)*w-playerZ);
  };
  const fallback=[...parents.values()].sort((a,b)=>b[0]-a[0]||distance(a)-distance(b));
  for(const tile of fallback)yield tile;
  for(const tile of leaves)yield tile;
}
export class Horizon {
  readonly gpu: HorizonRenderer;
  readonly radius: number;
  readonly tiles = new Map<string,Tile>();
  stats={sourceBytes:0,generated:0,coarseGenerated:0,coarsestGeneratedLevel:0,cached:0,coarseCached:0,pending:0,tiles:0,captured:0,cacheFull:false};
  private queue: Generator<[number,number,number]>|null=null;
  private cx=NaN;private cz=NaN;
  private requests: {level:number;x:number;z:number;epoch:number}[]=[];
  /** Cache lookups and worker jobs in flight, keyed by leaf coordinates. */
  private readonly pending = new Map<string,number>();
  private epoch=0;
  private dirty = new Set<Chunk>();
  private uploads = new Map<string,Tile>();
  private namespace='';
  private mask=new Uint8Array(128*128);
  constructor(private manager:ChunkManager,gl:GL,atlas:Atlas,worldId:string,seed:string){
    this.gpu=new HorizonRenderer(gl,atlas);
    const n=Number(new URLSearchParams(location.search).get('horizon')??128);
    this.radius=Number.isFinite(n)?Math.max(0,Math.min(512,Math.trunc(n))):128;
    this.namespace=`dh2:${BUILD_ID}:${worldId}:${seed}:`;
  }
  get enabled():boolean{return this.radius>0&&!this.manager.remote&&this.manager.world.dim.id==='overworld';}
  private key(t:Tile):string{return tileKey(t.level,t.x,t.z);}
  private bytes(t:Tile):number {return t.columns.reduce((n,c)=>n+c.byteLength+64,256);}
  private cacheKey(l:number,x:number,z:number):string{return `${this.namespace}${this.manager.world.dim.id}:${tileKey(l,x,z)}`;}
  mark(c:Chunk):void {if(this.enabled)this.dirty.add(c);}
  private accept(t:Tile,persist=true):void {
    const key=this.key(t),previous=this.tiles.get(key);
    if(previous)this.stats.sourceBytes-=this.bytes(previous);
    this.stats.sourceBytes+=this.bytes(t);
    this.tiles.set(key,t);this.uploads.set(key,t);
    if(persist)void saveTile(this.cacheKey(t.level,t.x,t.z),t);
    if(t.level<7){
      const px=Math.floor(t.x/2),pz=Math.floor(t.z/2);
      const parent=this.tiles.get(tileKey(t.level+1,px,pz));
      if(parent)this.accept(mergeChildIntoParent(parent,t));
      const children:Tile[]=[];
      for(let x=0;x<2;x++)for(let z=0;z<2;z++){
        const child=this.tiles.get(tileKey(t.level,px*2+x,pz*2+z));if(child)children.push(child);
      }
      if(children.length===4)this.accept(mergeTiles(children));
    }
    this.stats.tiles=this.tiles.size;
  }
  update():void {
    if(!this.enabled)return;
    const world=this.manager.world;
    // A bounded capture/upload batch; the near renderer always has first priority.
    for(const c of this.dirty){
      if(!world.chunks.has(c.key)){this.dirty.delete(c);continue;}
      if(c.dirty||c.meshing)continue;
      this.accept(captureChunk(c));this.dirty.delete(c);this.stats.captured++;break;
    }
    const upload=this.uploads.entries().next().value as [string,Tile]|undefined;
    if(upload){this.gpu.upload(upload[1]);this.uploads.delete(upload[0]);}
    // Coarse parents remain resident. Fine child data can be restored from IndexedDB.
    for(const [key,t] of this.tiles){
      const w=16*2**t.level,d=Math.hypot((t.x+.5)*w-this.cx*16,(t.z+.5)*w-this.cz*16);
      const parent=this.tiles.get(tileKey(t.level+1,Math.floor(t.x/2),Math.floor(t.z/2)));
      if(parent&&this.gpu.ready(parent)&&t.level<detailLevel(Math.max(0,d-w))){
        this.tiles.delete(key);this.stats.sourceBytes-=this.bytes(t);this.uploads.delete(key);this.gpu.drop(key);
      }
    }
    this.stats.cacheFull=this.stats.sourceBytes>64*1024*1024||this.gpu.stats.bytes>128*1024*1024;
  }
  private finishPending(level:number,x:number,z:number,epoch:number):void {
    const key=tileKey(level,x,z);
    if(this.pending.get(key)!==epoch)return;
    this.pending.delete(key);
    this.stats.pending=this.pending.size;
  }
  nextJob():Job|null {
    if(!this.enabled||this.stats.cacheFull)return null;
    const request=this.requests.shift();
    if(request){
      const {level,x,z,epoch}=request;
      return {type:'horizon',cx:x,cz:z,level,done:t=>{
        if(epoch!==this.epoch)return;
        this.finishPending(level,x,z,epoch);
        this.accept(t);this.stats.generated++;this.stats.coarsestGeneratedLevel=Math.max(this.stats.coarsestGeneratedLevel,level);if(level>0)this.stats.coarseGenerated++;
      },failed:()=>this.finishPending(level,x,z,epoch)};
    }
    if(!this.queue)return null;
    const limit=Math.max(1,this.manager.pool.size);
    while(this.pending.size<limit){
      const next=this.queue.next();if(next.done)break;
      const [level,x,z]=next.value,key=tileKey(level,x,z);
      if(this.tiles.has(key)||this.pending.has(key))continue;
      if(level===0&&this.manager.world.getChunk(x,z))continue;
      const epoch=this.epoch;
      this.pending.set(key,epoch);this.stats.pending=this.pending.size;
      void loadTile(this.cacheKey(level,x,z)).then(async cached=>{
        if(epoch!==this.epoch||this.pending.get(key)!==epoch)return;
        if(cached){
          this.accept(cached,false);this.stats.cached++;this.stats.coarsestGeneratedLevel=Math.max(this.stats.coarsestGeneratedLevel,level);if(level>0)this.stats.coarseCached++;
          this.finishPending(level,x,z,epoch);this.manager.pool.pump();return;
        }
        if(epoch!==this.epoch||this.pending.get(key)!==epoch)return;
        this.requests.push({level,x,z,epoch});this.manager.pool.pump();
      }).catch(err=>{
        if(epoch!==this.epoch||this.pending.get(key)!==epoch)return;
        this.finishPending(level,x,z,epoch);console.warn('Horizon data load failed',err);this.manager.pool.pump();
      });
    }
    return null;
  }
  center(x:number,z:number):void {
    x=Math.floor(x/16);z=Math.floor(z/16);
    if(!this.queue||Math.abs(x-this.cx)>=8||Math.abs(z-this.cz)>=8){
      this.cx=x;this.cz=z;this.epoch++;this.requests=[];this.pending.clear();this.stats.pending=0;
      this.queue=coordinates(x,z,this.radius);
    }
  }

  draw(p:TerrainParams,nearDistance:number):void {
    if(!this.enabled)return;
    const mx=Math.floor(p.camX/16)-64,mz=Math.floor(p.camZ/16)-64;this.mask.fill(0);
    for(const c of this.manager.world.chunks.values()){
      const x=c.cx-mx,z=c.cz-mz;
      if(x<0||z<0||x>=128||z>=128||c.dirty||c.meshing)continue;
      if(Math.hypot(c.cx*16+8-p.camX,c.cz*16+8-p.camZ)>nearDistance+16)continue;
      this.mask[z*128+x]=1;
    }
    this.gpu.setCoverage(mx,mz,this.mask);
    const selected:Tile[]=[],get=(l:number,x:number,z:number)=>this.tiles.get(tileKey(l,x,z));
    for(const t of this.tiles.values()){
      let ancestor = false;
      for (let l=t.level+1;l<=7;l++) if(get(l,Math.floor(t.x/2**(l-t.level)),Math.floor(t.z/2**(l-t.level)))) {ancestor=true;break;}
      if(ancestor)continue;
      const width=16*2**t.level;
      if(Math.hypot((t.x+.5)*width-p.camX,(t.z+.5)*width-p.camZ)>this.radius*16+width)continue;
      selected.push(...selectTiles(t,get,v=>this.gpu.ready(v),p.camX,p.camZ));
    }
    this.gpu.draw(selected,p,this.radius*16);
  }
  reset():void {this.epoch++;this.queue=null;this.requests=[];this.pending.clear();this.tiles.clear();this.stats.sourceBytes=0;this.stats.tiles=0;this.stats.pending=0;this.dirty.clear();this.uploads.clear();this.gpu.reset();}
  dispose():void {this.reset();this.gpu.dispose();}
}
