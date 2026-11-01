import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
const dir='tmp/horizon-smoke';await fs.mkdir(dir,{recursive:true});
const server=spawn('npm',['run','preview','--','--host','127.0.0.1'],{stdio:'ignore'});
let browser;
const errors=[];const report={};
try{
  for(let i=0;i<100;i++){try{if((await fetch('http://127.0.0.1:4173')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
  browser=await chromium.launch({headless:true,args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-dev-shm-usage']});
  const page=await browser.newPage({viewport:{width:960,height:540}});
  page.on('pageerror',e=>errors.push(String(e)));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  await page.addInitScript(()=>{
    const counters=window.__gl={draws:0,errors:[],shaderErrors:[]};
    for(const name of ['drawArrays','drawElements','drawArraysInstanced','drawElementsInstanced']){
      const original=WebGL2RenderingContext.prototype[name];
      WebGL2RenderingContext.prototype[name]=function(...args){counters.draws++;return original.apply(this,args);};
    }
    const compile=WebGL2RenderingContext.prototype.compileShader;
    WebGL2RenderingContext.prototype.compileShader=function(shader){compile.call(this,shader);if(!this.getShaderParameter(shader,this.COMPILE_STATUS))counters.shaderErrors.push(this.getShaderInfoLog(shader));};
    const getError=WebGL2RenderingContext.prototype.getError;
    WebGL2RenderingContext.prototype.getError=function(){const e=getError.call(this);if(e)counters.errors.push(e);return e;};
  });
  await page.goto('http://127.0.0.1:4173/?quick&seed=dh-port-smoke&rd=2&horizon=128&t=6000',{timeout:60000});
  await page.waitForFunction(()=>window.__game?.spawned,null,{timeout:180000});
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{const g=window.__game;g.screen=null;g.player.setGameMode('spectator');g.teleport(g.player.x,140,g.player.z,0,5);g.player.flying=true;});
  await page.waitForFunction(()=>{const s=window.__game.renderer.horizon.gpu.stats;return s.coarsestDrawnLevel>=3&&s.farthestDrawnDistanceBlocks>=768;},null,{timeout:180000});
  await page.waitForFunction(()=>window.__game.renderer.horizon.gpu.stats.draws>0,null,{timeout:120000});
  await page.waitForTimeout(1500);
  report.first=await page.evaluate(()=>({stats:window.__game.renderer.horizon.stats,gpu:window.__game.renderer.horizon.gpu.stats,gl:window.__gl}));
  report.view=await page.evaluate(()=>({position:[window.__game.player.x,window.__game.player.y,window.__game.player.z],yaw:window.__game.player.yaw,pitch:window.__game.player.pitch,horizon:window.__game.renderer.horizon.gpu.stats}));
  await page.screenshot({path:dir+'/initial.png'});
  await page.evaluate(()=>{window.__game.opts.hyperShader=true;});
  await page.waitForTimeout(2000);
  report.hyper=await page.evaluate(()=>({gl:window.__gl,gpu:window.__game.renderer.horizon.gpu.stats}));
  await page.screenshot({path:dir+'/hyper.png'});
  // Reset must cancel old completions and remove stale CPU/GPU state.
  report.reset=await page.evaluate(()=>{const h=window.__game.renderer.horizon;h.reset();return {tiles:h.tiles.size,bytes:h.gpu.stats.bytes};});
  if(report.reset.tiles||report.reset.bytes)throw Error('Reset leaked LOD data');
  if(!report.first.gl.draws||report.hyper.gl.errors.length||report.hyper.gl.shaderErrors.length||report.first.gl.errors.length||report.first.gl.shaderErrors.length||errors.length)throw Error('Runtime errors or missing draws');
  report.result='PASS_SMOKE';
}catch(e){report.result='FAIL';report.error=String(e);try{report.diagnostic=await page?.evaluate(()=>({horizon:window.__game?.renderer?.horizon?.stats,gpu:window.__game?.renderer?.horizon?.gpu?.stats,position:window.__game?.player&&[window.__game.player.x,window.__game.player.y,window.__game.player.z],gl:window.__gl}));}catch{}process.exitCode=1;}
finally{report.errors=errors;console.log(JSON.stringify(report));await fs.writeFile(dir+'/report.json',JSON.stringify(report,null,2));await browser?.close();server.kill();}
