/* Adapted from RenderDataPointReducingList (Builderb0y / DH contributors),
 * Copyright (C) 2020 James Seibel. LGPL-3.0-only.
 * Opaque rendering mode; full source data is NEVER reduced in storage.
 */
import type { Column, Span } from './data';
/** DH's ascending-size reduction with air gaps represented explicitly. The
 * original linked-list optimization is replaced by arrays for short columns. */
export function reduceRenderColumn(source:Column,target:number):Column {
  if(source.length<=target)return source;
  if(target<1)return [];
  if(target===1){
    // RenderDataPointReducingList.reduceToOne: highest properties, lowest minY.
    return [{...source[source.length-1],bottom:source[0].bottom}];
  }
  const nodes:Span[]=[];
  for(const s of source){
    const last=nodes[nodes.length-1];
    if(last&&last.top<s.bottom)nodes.push({bottom:last.top,top:s.bottom,id:0,sky:0,block:0});
    nodes.push({...s});
  }
  const visible=()=>nodes.reduce((n,s)=>n+(s.id?1:0),0);
  const size=(s:Span)=>s.top-s.bottom;
  const sorted=()=>nodes.slice().sort((a,b)=>size(a)-size(b)||nodes.indexOf(b)-nodes.indexOf(a));
  const same=(a:Span|undefined,b:Span)=>a!==undefined&&Boolean(a.id)===Boolean(b.id);
  const merge=(current:Span):boolean=>{
    const i=nodes.indexOf(current);if(i<0)return false;
    const lower=nodes[i-1],higher=nodes[i+1];
    if(same(higher,current)&&(!same(lower,current)||size(higher)<=size(lower))){
      higher.bottom=current.bottom;nodes.splice(i,1);return true;
    }
    if(same(lower,current)){current.bottom=lower.bottom;nodes.splice(i-1,1);return true;}
    return false;
  };
  // DH fast paths: segments of height one and two, largest-small-node first.
  for(let special=1;special<=2;special++)for(const s of sorted().filter(s=>size(s)<=special).reverse()){
    if(visible()<=target)return nodes.filter(s=>s.id);merge(s);
  }
  // General connected-segment pass restarts at smallest following each merge.
  while(visible()>target){let changed=false;
    for(const s of sorted())if(merge(s)){changed=true;break;}
    if(!changed)break;
  }
  // Eliminate the smallest separator whose neighbours have matching alpha.
  while(visible()>target){let changed=false;
    for(const s of sorted()){
      const i=nodes.indexOf(s),low=nodes[i-1],high=nodes[i+1];
      if(low&&high&&Boolean(low.id)===Boolean(high.id)){
        high.bottom=low.bottom;nodes.splice(i-1,2);changed=true;break;
      }
    }
    if(!changed)break;
  }
  // Last resort: force the bottom visible segment into the next visible one.
  while(visible()>target){
    const low=nodes.findIndex(s=>!!s.id),high=nodes.findIndex((s,i)=>i>low&&!!s.id);
    if(high<0)break;
    nodes[high].bottom=nodes[low].bottom;nodes.splice(low,high-low);
  }
  return nodes.filter(s=>s.id);
}
export const verticalLimit=(level:number):number=>[6,6,6,4,4,4,4,4,4,4,1][Math.max(0,Math.min(10,level))];
