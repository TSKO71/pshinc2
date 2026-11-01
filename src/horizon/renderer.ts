import { Shader, type GL } from '../render/gl';
import type { Atlas } from '../render/atlas';
import type { TerrainParams } from '../render/worldRenderer';
import { BLOCKS, STATE_BLOCK, STATE_VIEWS } from '../world/block';
import { BIOMES } from '../world/gen/biomes';
import type { Variant } from '../world/models';
import type { Tile } from './data';
import { tileKey, TILE_SIZE } from './data';
import { meshTile } from './mesh';
const VS = `#version 300 es
layout(location=0) in vec3 pos; layout(location=1) in vec3 color; layout(location=2) in float light;
uniform mat4 proj,view; uniform vec3 offset; uniform vec2 origin;
out vec3 rgb; out vec2 lm; out vec2 worldXZ; out float dist;
void main(){vec3 p=pos+offset;gl_Position=proj*view*vec4(p,1.);rgb=color;lm=(vec2(mod(light,16.),floor(light/16.))+.5)/16.;worldXZ=pos.xz+origin;dist=length(p.xz);}`;
const FS = `#version 300 es
precision highp float; precision highp usampler2D;
in vec3 rgb; in vec2 lm; in vec2 worldXZ; in float dist;
uniform sampler2D lightmap; uniform usampler2D coverage; uniform vec2 maskOrigin;
uniform vec3 fogColor; uniform vec2 fogRange; out vec4 o;
void main(){ivec2 c=ivec2(floor(worldXZ/16.)-maskOrigin);if(all(greaterThanEqual(c,ivec2(0)))&&all(lessThan(c,ivec2(128)))){if(texelFetch(coverage,c,0).r>0u)discard;}
float f=smoothstep(fogRange.x,fogRange.y,dist);o=vec4(mix(rgb*texture(lightmap,lm).rgb,fogColor,f),1.);}`;
interface Mesh { vao: WebGLVertexArrayObject; vbo: WebGLBuffer; count: number; bytes: number; source: Tile }
export class HorizonRenderer {
  private shader: Shader;
  private mask: WebGLTexture;
  private indices: WebGLBuffer;
  private indexCapacity = 0;
  private meshes = new Map<string, Mesh>();
  private colors = new Map<number, number>();
  maskX = 0; maskZ = 0;
  stats = { draws: 0, vertices: 0, bytes: 0, coarsestDrawnLevel: 0, farthestDrawnDistanceBlocks: 0 };
  constructor(private gl: GL, private atlas: Atlas) {
    this.shader = new Shader(gl, VS, FS, 'horizon');
    this.indices = gl.createBuffer()!;
    this.mask = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D,this.mask);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.R8UI,128,128,0,gl.RED_INTEGER,gl.UNSIGNED_BYTE,new Uint8Array(128*128));
  }
  private color = (id: number): number => {
    const old=this.colors.get(id);if(old!==undefined)return old;
    const state=id%65536, biome=BIOMES[Math.floor(id/65536)]??BIOMES[0];
    const b=BLOCKS[STATE_BLOCK[state]], choice=b.s.model?.(STATE_VIEWS[state]);
    let variant: Variant|undefined;
    if(Array.isArray(choice))variant=choice[0];
    else if(choice&&'parts' in choice){const c=choice.parts[0];variant=Array.isArray(c)?c[0]:c;}
    else variant=choice;
    const model=variant?.model;
    const face=model?.elements.find(e=>e.faces.up)?.faces.up;
    const tex=face?.tex??model?.particle??(b.name==='water'?'water_still':b.name==='lava'?'lava_still':b.name);
    const sprite=this.atlas.sprites[tex]??this.atlas.sprites.missing;
    let r=0,g=0,blue=0,a=0;
    if(sprite)for(let y=Math.floor(sprite.v0*this.atlas.size);y<Math.ceil(sprite.v1*this.atlas.size);y++)for(let x=Math.floor(sprite.u0*this.atlas.size);x<Math.ceil(sprite.u1*this.atlas.size);x++){
      const p=(y*this.atlas.size+x)*4,alpha=this.atlas.pixels[p+3]/255;
      r+=this.atlas.pixels[p]*alpha;g+=this.atlas.pixels[p+1]*alpha;blue+=this.atlas.pixels[p+2]*alpha;a+=alpha;
    }
    r/=a||1;g/=a||1;blue/=a||1;
    let tint=0xffffff;
    if(b.tint==='water')tint=biome.water;
    else if(face?.tint!==undefined){
      tint=b.tint==='grass'?biome.grass:b.tint==='foliage'?biome.foliage:b.tint==='birch'?0x80a755:b.tint==='spruce'?0x619961:b.s.tintColor??0xffffff;
    }
    const c=(Math.round(r*((tint>>16)&255)/255)<<16)|(Math.round(g*((tint>>8)&255)/255)<<8)|Math.round(blue*(tint&255)/255);
    this.colors.set(id,c);return c;
  };
  ready(t:Tile):boolean {return this.meshes.has(tileKey(t.level,t.x,t.z));}
  upload(t:Tile):void {
    const key=tileKey(t.level,t.x,t.z),old=this.meshes.get(key);
    if(old?.source===t)return;
    const floats=meshTile(t,this.color),gl=this.gl;
    const count=floats.length/7, data=new ArrayBuffer(count*12),view=new DataView(data);
    for(let i=0;i<count;i++){
      const p=i*7,o=i*12;
      view.setUint16(o,floats[p],true);view.setUint16(o+2,floats[p+1]+64,true);view.setUint16(o+4,floats[p+2],true);
      for(let c=0;c<3;c++)view.setUint8(o+6+c,Math.round(floats[p+3+c]*255));view.setUint8(o+9,floats[p+6]);
    }
    const quads=count/4;
    if(quads>this.indexCapacity){
      this.indexCapacity=Math.max(quads,this.indexCapacity*2,1024);
      const ids=new Uint32Array(this.indexCapacity*6);
      for(let q=0;q<this.indexCapacity;q++)ids.set([q*4,q*4+1,q*4+2,q*4,q*4+2,q*4+3],q*6);
      gl.bindBuffer(gl.COPY_WRITE_BUFFER,this.indices);gl.bufferData(gl.COPY_WRITE_BUFFER,ids,gl.STATIC_DRAW);
    }
    const vao=gl.createVertexArray()!,vbo=gl.createBuffer()!;
    gl.bindVertexArray(vao);gl.bindBuffer(gl.ARRAY_BUFFER,vbo);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.UNSIGNED_SHORT,false,12,0);
    gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,3,gl.UNSIGNED_BYTE,true,12,6);
    gl.enableVertexAttribArray(2);gl.vertexAttribPointer(2,1,gl.UNSIGNED_BYTE,false,12,9);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,this.indices);
    gl.bindVertexArray(null);
    if(old)this.drop(key);
    this.meshes.set(key,{vao,vbo,count:quads*6,bytes:data.byteLength,source:t});this.stats.bytes+=data.byteLength;
  }
  setCoverage(x:number,z:number,data:Uint8Array):void {
    this.maskX=x;this.maskZ=z;
    const gl=this.gl;gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,this.mask);
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,128,128,gl.RED_INTEGER,gl.UNSIGNED_BYTE,data);
    gl.activeTexture(gl.TEXTURE0);
  }
  draw(tiles:Tile[],p:TerrainParams,radius:number):void {
    const gl=this.gl,s=this.shader.use();this.stats.draws=0;this.stats.vertices=0;this.stats.coarsestDrawnLevel=0;this.stats.farthestDrawnDistanceBlocks=0;
    gl.enable(gl.DEPTH_TEST);gl.depthMask(true);gl.disable(gl.BLEND);gl.disable(gl.CULL_FACE);
    s.mat4('proj',p.proj);s.mat4('view',p.view);s.vec3('fogColor',...p.fogColor);s.vec2('fogRange',radius*.7,radius);
    s.vec2('maskOrigin',this.maskX,this.maskZ);s.i('lightmap',1);s.i('coverage',7);
    gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,p.lightmap);
    gl.activeTexture(gl.TEXTURE7);gl.bindTexture(gl.TEXTURE_2D,this.mask);
    for(const t of tiles){const width=TILE_SIZE*2**t.level,x=t.x*width,z=t.z*width;
      if(!p.frustum.testBox(x-p.camX,-64-p.camY,z-p.camZ,x+width-p.camX,320-p.camY,z+width-p.camZ))continue;
      const m=this.meshes.get(tileKey(t.level,t.x,t.z));if(!m)continue;
      s.vec3('offset',x-p.camX,-p.camY-64,z-p.camZ);s.vec2('origin',x,z);gl.bindVertexArray(m.vao);gl.drawElements(gl.TRIANGLES,m.count,gl.UNSIGNED_INT,0);
      this.stats.draws++;this.stats.vertices+=m.count;this.stats.coarsestDrawnLevel=Math.max(this.stats.coarsestDrawnLevel,t.level);this.stats.farthestDrawnDistanceBlocks=Math.max(this.stats.farthestDrawnDistanceBlocks,Math.hypot(x+width/2-p.camX,z+width/2-p.camZ));
    }
    gl.bindVertexArray(null);gl.enable(gl.CULL_FACE);gl.activeTexture(gl.TEXTURE0);
  }
  drop(key:string):void {const m=this.meshes.get(key);if(m){this.gl.deleteVertexArray(m.vao);this.gl.deleteBuffer(m.vbo);this.stats.bytes-=m.bytes;this.meshes.delete(key);}}
  reset():void {for(const key of this.meshes.keys())this.drop(key);}
  dispose():void {this.reset();this.gl.deleteTexture(this.mask);this.gl.deleteBuffer(this.indices);this.gl.deleteProgram(this.shader.program);}
}
