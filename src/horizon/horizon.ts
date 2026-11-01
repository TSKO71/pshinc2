import { BUILD_ID } from '../net/config';
import { type Tile, tileKey, mergeTiles, selectTiles, detailLevel } from './data';
import { captureChunk } from './source';
import { loadTile, saveTile } from './store';
import { HorizonRenderer } from './renderer';
import type { ChunkManager } from '../world/chunkManager';
import type { Chunk } from '../world/chunk';
import type { Job } from '../worker/pool';
import type { TerrainParams } from '../render/worldRenderer';
import type { GL } from '../render/gl';
import type { Atlas } from '../render/atlas';

function* coordinates(cx:number,cz:number,radius:number):Generator<[number,number]> {
  yield [cx,cz];
  for(let r=1;r<=radius;r++)for(let i=-r;i<=r;i++){
    if(i*i+r*r>radius*radius)continue;
    yield [cx+i,cz-r];yield [cx+i,cz+r];
    if(Math.abs(i)!==r){yield [cx-r,cz+i];yield [cx+r,cz+i];}
  }
}
export class Horizon {
  readonly gpu: HorizonRenderer;
  readonly radius: number;
  readonly tiles = new Map<string,Tile>();
  stats={generated:0,cached:0,pending:0,tiles:0,captured:0,cacheFull:false};
  private queue: Generator<[number,number]>|null=null;
  private cx=NaN;private cz=NaN;
  private requests: {x:number;z:number;saved:Awaited<ReturnType<NonNullable<ChunkManager['savedLoader']>>>}[]=[];
  private busy=false;private epoch=0;
  private dirty = new Set<Chunk>();
  private recovering = new Set<string>();
  private uploads = new Map<string,Tile>();
  private namespace='';
  private mask=new Uint8Array(128*128);
  constructor(private manager:ChunkManager,gl:GL,atlas:Atlas,worldId:string,seed:string){
    this.gpu=new HorizonRenderer(gl,atlas);
    const n=Number(new URLSearchParams(location.search).get('horizon')??128);
    this.radius=Number.isFinite(n)?Math.max(0,Math.min(512,Math.trunc(n))):128;
    this.namespace=`dh1:${BUILD_ID}:${worldId}:${seed}:`;
  }
  get enabled():boolean{return this.radius>0&&!this.manager.remote&&this.manager.world.dim.id==='overworld';}
  private key(t:Tile):string{return tileKey(t.level,t.x,t.z);}
  private cacheKey(l:number,x:number,z:number):string{return `${this.namespace}${this.manager.world.dim.id}:${tileKey(l,x,z)}`;}
  mark(c:Chunk):void {if(this.enabled)this.dirty.add(c);}
  private accept(t:Tile,persist=true):void {
    const key=this.key(t);this.tiles.set(key,t);this.uploads.set(key,t);
    if(persist)void saveTile(this.cacheKey(t.level,t.x,t.z),t);
    if(t.level<7){
      const px=Math.floor(t.x/2),pz=Math.floor(t.z/2),children:Tile[]=[];
      for(let x=0;x<2;x++)for(let z=0;z<2;z++){
        const child=this.tiles.get(tileKey(t.level,px*2+x,pz*2+z));if(child)children.push(child);
      }
      if(children.length===4)this.accept(mergeTiles(children));
      else if(this.tiles.has(tileKey(t.level+1,px,pz))){
        // Edited fine data must also reach a resident coarse ancestor.
        for(let x=0;x<2;x++)for(let z=0;z<2;z++){
          const sx=px*2+x,sz=pz*2+z,k=tileKey(t.level,sx,sz);
          if(this.tiles.has(k)||this.recovering.has(k))continue;
          this.recovering.add(k);const epoch=this.epoch;
          void loadTile(this.cacheKey(t.level,sx,sz)).then(c=>{
            if(epoch!==this.epoch)return;this.recovering.delete(k);
            if(c&&!this.tiles.has(k))this.accept(c,false);
          });
        }
      }
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
        this.tiles.delete(key);this.uploads.delete(key);this.gpu.drop(key);
      }
    }
    this.stats.cacheFull=this.tiles.size>=4096||this.gpu.stats.bytes>128*1024*1024;
  }
  private covered(x:number,z:number):boolean {
    const desired=detailLevel(Math.hypot((x-this.cx)*16,(z-this.cz)*16));
    for(let l=0;l<=desired;l++)if(this.tiles.has(tileKey(l,Math.floor(x/2**l),Math.floor(z/2**l))))return true;
    return false;
  }
  nextJob():Job|null {
    if(!this.enabled||this.stats.cacheFull)return null;
    const request=this.requests.shift();
    if(request){
      const epoch=this.epoch;
      return {type:'horizon',cx:request.x,cz:request.z,saved:request.saved,done:t=>{
        if(epoch!==this.epoch)return;
        this.busy=false;this.stats.pending=0;
        this.accept(t);this.stats.generated++;
      },failed:()=>{if(epoch===this.epoch){this.busy=false;this.stats.pending=0;}}};
    }
    if(this.busy||!this.queue)return null;
    for(let i=0;i<64;i++){
      const next=this.queue.next();if(next.done)return null;
      const [x,z]=next.value;
      if(this.covered(x,z)||this.manager.world.getChunk(x,z))continue;
      this.busy=true;this.stats.pending=1;const epoch=this.epoch;
      void loadTile(this.cacheKey(0,x,z)).then(async cached=>{
        if(epoch!==this.epoch)return;
        if(cached){this.accept(cached,false);this.stats.cached++;this.busy=false;this.stats.pending=0;return;}
        const saved=await this.manager.savedLoader?.(x,z)??null;
        if(epoch!==this.epoch)return;
        this.requests.push({x,z,saved});this.manager.pool.pump();
      }).catch(err=>{if(epoch===this.epoch){this.busy=false;this.stats.pending=0;console.warn('Horizon data load failed',err);}});
      break;
    }
    return null;
  }
  center(x:number,z:number):void {
    x=Math.floor(x/16);z=Math.floor(z/16);
    if(!this.queue||Math.abs(x-this.cx)>=8||Math.abs(z-this.cz)>=8){this.cx=x;this.cz=z;this.queue=coordinates(x,z,this.radius);}
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
  reset():void {this.epoch++;this.queue=null;this.busy=false;this.requests=[];this.tiles.clear();this.dirty.clear();this.recovering.clear();this.uploads.clear();this.gpu.reset();}
  dispose():void {this.reset();this.gpu.dispose();}
}
