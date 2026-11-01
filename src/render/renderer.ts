// Frame orchestration: camera matrices, sky, terrain, (entities), clouds.

import type { Horizon } from '../horizon/horizon';
import { GL } from './gl';
import { Atlas } from './atlas';
import { Lightmap } from './lightmap';
import { SkyRenderer } from './sky';
import { WorldRenderer } from './worldRenderer';
import { CloudRenderer } from './clouds';
import { mat4, perspective, rotateX, rotateY, Frustum, multiply, DEG, Mat4 } from '../core/math';
import * as env from './environment';
import { BIOMES } from '../world/gen/biomes';
import { EntityBatch, PoseStack } from './entityRenderer';
import { ItemRenderer } from './itemRenderer';
import { HandRenderer } from './handRenderer';
import type { Level } from '../game/level';
import type { TexImage } from '../textures/tex';
import { ParticleEngine } from './particles';
import { WeatherRenderer } from './weather';
import { EntityRenderDispatcher, EntityRenderOptions } from './entityRenderers';
import { buildParticleAtlas } from './particleAtlas';
import type { BlindnessFog, DarknessVisuals } from './effectVisuals';
import { OVERWORLD, type DimensionType } from '../world/dimension';
import { EndRenderer } from './endRenderer';
// (the beacon)
import { BeaconRenderer } from './beaconRenderer';
import { HyperFrame } from './hyperShader';

export interface Camera {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  fov: number;
}

export interface FrameEnv {
  dayTime: number;
  ticks: number;
  partial: number;
  weather: env.Weather;
  biome: number;
  gamma: number;
  hyperShader?: boolean;
  /** Optional owned capture target, used by the title panorama. */
  outputFramebuffer?: WebGLFramebuffer | null;
  nightVision: number;
  /** blindness fog (effectVisuals.blindnessFog) */
  blindness?: BlindnessFog | null;
  /** the darkness effect's fog and lightmap (effectVisuals.darknessVisuals) */
  darkness?: DarknessVisuals | null;
  /** extra (e.g. view bobbing) applied to view matrix */
  bob?: Mat4 | null;
  underwater?: boolean;
  waterFogColor?: [number, number, number];
  /** the camera is in lava: how far the player can see there (vanilla FogRenderer, FogType.LAVA) */
  lava?: 'normal' | 'fire_resistant' | 'spectator' | null;
  /** (powder snow) the camera is in powder snow (vanilla FogType.POWDER_SNOW): 'spectator' sees further */
  powderSnow?: 'normal' | 'spectator' | null;
  /** the dimension's sky, fog and light (vanilla DimensionSpecialEffects) */
  dim?: DimensionType;
  /** a boss bar asks for the fog to close in (vanilla BossHealthOverlay.shouldCreateWorldFog: the dragon's) */
  worldFog?: boolean;
  /** (the wither) vanilla GameRenderer.getDarkenWorldAmount: a bar darkening the screen (the lightmap and the fog's colour) */
  darkenWorld?: number;
  /** the biome fog and sky colours blended round the camera (environment.blendBiomeColors) */
  biomeColors?: { fog: env.RGB; sky: env.RGB };
  level?: Level;
  entityOptions?: EntityRenderOptions;
}

export class Renderer {
  readonly lightmap: Lightmap;
  readonly sky: SkyRenderer;
  readonly world: WorldRenderer;
  readonly clouds: CloudRenderer;
  readonly batch: EntityBatch;
  readonly items: ItemRenderer;
  readonly hand: HandRenderer;
  readonly weather: WeatherRenderer;
  readonly entities: EntityRenderDispatcher;
  /** the End's sky and the end portal's starfield */
  readonly end: EndRenderer;
  /** (the beacon) vanilla BeaconRenderer's beams */
  readonly beacons: BeaconRenderer;
  private particleAtlas: ReturnType<typeof buildParticleAtlas> | null = null;
  particles: ParticleEngine | null = null;
  fancy = true;
  private readonly pose = new PoseStack();
  lastFogStart = 0;
  lastFogEnd = 0;
  /** vanilla FogShape: 0 sphere, 1 cylinder */
  lastFogShape = 1;
  readonly proj = mat4();
  readonly view = mat4();
  readonly viewRot = mat4();
  readonly viewProj = mat4();
  readonly frustum = new Frustum();
  private readonly reflectedFrustum = new Frustum();
  horizon: Horizon | null = null;
  renderDistance = 12;
  cloudsEnabled = true;
  skipClouds = false;
  width = 1;
  height = 1;
  lastFog: [number, number, number] = [0, 0, 0];
  private hyper: HyperFrame | null = null;

  constructor(readonly gl: GL, readonly atlas: Atlas, itemTextures: Record<string, () => TexImage> | null, blockImages: Map<string, TexImage>) {
    this.lightmap = new Lightmap(gl);
    this.sky = new SkyRenderer(gl);
    this.world = new WorldRenderer(gl);
    this.clouds = new CloudRenderer(gl);
    this.batch = new EntityBatch(gl);
    this.items = new ItemRenderer(gl, atlas, itemTextures, blockImages);
    this.hand = new HandRenderer(gl, this.items);
    this.weather = new WeatherRenderer(gl);
    this.entities = new EntityRenderDispatcher(gl, this.items, this.hand.skinTexture);
    this.end = new EndRenderer(gl);
    this.beacons = new BeaconRenderer(gl);
  }

  async prepareHyperShader(): Promise<void> {
    this.hyper ??= new HyperFrame(this.gl);
    await this.hyper.assetsReady;
  }

  releaseHyperShader(): void {
    this.hyper?.dispose();
    this.hyper = null;
  }

  resize(w: number, h: number): void {
    this.width = w;
    this.height = h;
  }

  setupCamera(cam: Camera, bob: Mat4 | null): void {
    const far = Math.max(this.renderDistance * 16 * 4, this.horizon?.enabled ? this.horizon.radius * 16 * 1.5 : 256);
    perspective(this.proj, cam.fov * DEG, this.width / this.height, 0.05, far);
    const v = this.viewRot;
    v.fill(0);
    v[0] = v[5] = v[10] = v[15] = 1;
    if (bob) v.set(bob);
    rotateX(v, v, cam.pitch * DEG);
    rotateY(v, v, (cam.yaw + 180) * DEG);
    this.view.set(v);
    multiply(this.viewProj, this.proj, this.view);
    this.frustum.setFromMatrix(this.viewProj);
  }

  render(cam: Camera, e: FrameEnv): void {
    const gl = this.gl;
    const dim = e.dim ?? OVERWORLD;
    // (a dimension with a fixed time always shows it: the Nether's lightmap is midnight's)
    const tod = env.timeOfDay(dim.fixedTime ?? e.dayTime + e.partial);
    const biome = BIOMES[e.biome] ?? BIOMES[1];
    const colors = e.biomeColors ?? { fog: env.rgb24(biome.fog), sky: env.rgb24(biome.sky) };
    this.setupCamera(cam, e.bob ?? null);
    const hyperEnabled = !!e.hyperShader && !e.blindness && !e.darkness && !e.lava && !e.powderSnow;
    if (!hyperEnabled && this.hyper) { this.hyper.dispose(); this.hyper = null; }
    const hyper = hyperEnabled ? (this.hyper ??= new HyperFrame(gl)) : null;
    if (hyper) {
      hyper.resize(this.width, this.height);
      hyper.prepare(this.proj, this.view, [cam.x, cam.y, cam.z], tod, (e.ticks + e.partial) / 20, e.weather.rain, this.cloudsEnabled, !!e.underwater, dim.id === 'the_nether' ? 1 : dim.id === 'the_end' ? 2 : 0);
      hyper.water.update(hyper.dimension===0?biome.name:hyper.water.key,hyper.time,cam.x,cam.z);
      hyper.brightness=e.gamma;hyper.nightVision=e.nightVision;
      hyper.flash=dim.hasSkyLight && e.weather.flash>0?1:0;
      hyper.wetness = dim.id === 'overworld' && biome.precipitation && biome.temperature >= 0.15 ? e.weather.rain : 0;
      if(e.level && hyper.wetness>0.01)hyper.updateRainExposure(e.level.world);
      if (e.level) hyper.cameraSky = Math.max(0.05, (e.level.world.getLight(Math.floor(cam.x), Math.floor(cam.y), Math.floor(cam.z)) >> 4) / 15);
      if (dim.id === 'the_nether') {
        const max = Math.max(...colors.fog, 0.1);
        hyper.fogTint = colors.fog.map(c => c / max * 0.20) as [number, number, number];
      }
    }
    // look vector
    const pr = cam.pitch * DEG, yr = cam.yaw * DEG;
    const lx = -Math.sin(yr) * Math.cos(pr), ly = -Math.sin(pr), lz = Math.cos(yr) * Math.cos(pr);
    const rdBlocks = this.renderDistance * 16;
    const sky = env.skyColor(colors.sky, tod, e.weather, e.partial);
    let fog = env.fogColor(colors.fog, colors.sky, tod, e.weather, this.renderDistance, lx, ly, lz, cam.y, dim.effects.fog, dim.minY);
    let fogStart = rdBlocks - Math.min(Math.max(rdBlocks / 10, 4), 64);
    let fogEnd = rdBlocks;
    // vanilla FogShape: cylindrical for the ordinary distance fog, spherical for the rest
    let fogShape = 1;
    if (e.lava) {
      fog = [0.6, 0.1, 0];
      fogShape = 0;
      if (e.lava === 'spectator') [fogStart, fogEnd] = [-8, rdBlocks * 0.5];
      else if (e.lava === 'fire_resistant') [fogStart, fogEnd] = [0, 5];
      else [fogStart, fogEnd] = [0.25, 1];
    } else if (e.powderSnow) {
      // (powder snow) vanilla FogRenderer, FogType.POWDER_SNOW: a white-blue wall two blocks off
      fog = [0.623, 0.734, 0.785];
      fogShape = 0;
      if (e.powderSnow === 'spectator') [fogStart, fogEnd] = [-8, rdBlocks * 0.5];
      else [fogStart, fogEnd] = [0, 2];
    } else if (e.underwater) {
      fog = e.waterFogColor ?? [0.02, 0.02, 0.2];
      fogStart = -8;
      fogEnd = 96;
      fogShape = 0;
    } else if (dim.effects.foggy || e.worldFog) {
      // vanilla isFoggyAt: the Nether's thick fog (and the dragon fight's)
      fogStart = rdBlocks * 0.05;
      fogEnd = Math.min(rdBlocks, 192) * 0.5;
      fogShape = 0;
    }
    // vanilla FogRenderer: blindness darkens the fog colour and pulls the fog in to a few blocks
    const blind = e.blindness;
    if (blind) {
      if (blind.darkness < 1) {
        const d = Math.max(0, blind.darkness) ** 2;
        fog = [fog[0] * d, fog[1] * d, fog[2] * d];
      }
      fogStart = blind.end * 0.25;
      fogEnd = blind.end;
      fogShape = 0;
    } else if (e.darkness) {
      // vanilla DarknessFogFunction (blindness comes first): the fog closes in to 15 blocks as the effect blends in,
      // its colour going to black (getModifiedVoidDarkness, squared)
      const f = rdBlocks + (15 - rdBlocks) * e.darkness.factor;
      const d = Math.max(0, 1 - e.darkness.factor) ** 2;
      fog = [fog[0] * d, fog[1] * d, fog[2] * d];
      fogStart = f * 0.75;
      fogEnd = f;
      fogShape = 0;
    }
    // ((the wither) vanilla FogRenderer.setupColor's bossColorModifier: a bar darkening the screen dims and reddens the fog)
    const dw = e.darkenWorld ?? 0;
    if (dw > 0) fog = [fog[0] * (1 - dw) + fog[0] * 0.7 * dw, fog[1] * (1 - dw) + fog[1] * 0.6 * dw, fog[2] * (1 - dw) + fog[2] * 0.6 * dw];
    // vanilla FogRenderer.setupColor: night vision brightens the fog (underwater, water vision does), but not in darkness
    const nv = e.underwater ? 0 : e.darkness ? 0 : e.nightVision;
    if (nv > 0 && fog[0] !== 0 && fog[1] !== 0 && fog[2] !== 0) {
      const k = Math.min(1 / fog[0], 1 / fog[1], 1 / fog[2]);
      fog = [fog[0] * (1 - nv) + fog[0] * k * nv, fog[1] * (1 - nv) + fog[1] * k * nv, fog[2] * (1 - nv) + fog[2] * k * nv];
    }
    if (hyper) {
      const day = Math.max(0, Math.min(1, (hyper.sun[1] + 0.12) / 0.35));
      const dusk = 1 - Math.min(1, Math.abs(hyper.sun[1]) * 2.6);
      fog = e.underwater ? [0.015, 0.20, 0.24] : [0.025 + day * (0.39 + dusk * 0.34), 0.035 + day * (0.50 - dusk * 0.12), 0.065 + day * (0.57 - dusk * 0.32)];
      fogStart = e.underwater ? 2 : rdBlocks * 0.38;
      fogEnd = e.underwater ? 64 : rdBlocks;
      if(hyper.dimension===0 && e.underwater){
        fog=hyper.water.fog.map(v=>v*0.28) as [number,number,number];
        fogStart=hyper.water.fogRange[0];fogEnd=hyper.water.fogRange[1];
      }
      if (hyper.dimension === 1) {
        fog = hyper.fogTint; fogStart = 16; fogEnd = Math.min(rdBlocks, 175);
      } else if (hyper.dimension === 2) {
        fog = [0.065, 0.034, 0.105]; fogStart = rdBlocks * 0.42; fogEnd = rdBlocks * 1.15;
      } else if (e.weather.rain > 0) {
        const rain = e.weather.rain * 0.65;
        fog = fog.map((c, i) => c * (1 - rain) + [0.24, 0.29, 0.34][i] * rain) as [number, number, number];
        fogStart *= 1 - e.weather.rain * 0.5;
      }
      if (e.worldFog) { fogStart = Math.min(fogStart, 8); fogEnd *= 0.6; }
    }
    this.lastFog = fog;
    // lightmap
    this.lightmap.update(env.skyDarken(tod, e.weather), e.weather.flash > 0, e.gamma, e.nightVision, dim.ambientLight, dim.effects.forceBrightLightmap, e.darkness?.gamma ?? 0, e.darkness?.pulse ?? 0, dw, !!hyper && hyper.dimension === 0);
    if (hyper) hyper.beginScene();
    // clear to fog color
    gl.viewport(0, 0, this.width, this.height);
    gl.clearColor(fog[0], fog[1], fog[2], 1);
    gl.clearDepth(1);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    // vanilla LevelRenderer.renderSky: no sky in lava or while blind or in darkness (doesMobEffectBlockSky), none at all in the Nether
    // ((powder snow) nor in powder snow)
    const skyBlocked = !!blind || !!e.darkness || !!e.powderSnow;
    // The air sky is needed behind the refracting underside as well. Water
    // absorption is applied at the fluid surface, not baked into a stale map.
    if (hyper && hyper.dimension!==2) hyper.drawSky();
    if (!hyper && !e.underwater && !e.lava && !skyBlocked && dim.effects.sky === 'normal') {
      this.sky.render({
        proj: this.proj,
        viewRot: this.viewRot,
        skyColor: sky,
        fogColor: fog,
        renderDistanceBlocks: rdBlocks,
        sunrise: env.sunriseColor(tod),
        timeOfDay: tod,
        rain: e.weather.rain,
        starBrightness: env.starBrightness(tod),
        moonPhase: env.moonPhase(e.dayTime),
        horizonDelta: cam.y - 63,
      });
    }
    // (vanilla renderEndSky: under water too, not in lava or while blind)
    if (!hyper && !e.lava && !skyBlocked && dim.effects.sky === 'end') this.end.renderSky(this.proj, this.viewRot);
    const tp = {
      proj: this.proj,
      view: this.view,
      camX: cam.x,
      camY: cam.y,
      camZ: cam.z,
      fogColor: fog,
      fogStart,
      fogEnd,
      fogShape,
      atlas: this.atlas.texture!,
      lightmap: this.lightmap.texture,
      frustum: this.frustum,
      hyper: hyper ?? undefined,
    };
    if (this.horizon?.enabled && !e.underwater && !e.lava && !skyBlocked) {
      tp.fogStart = this.horizon.radius * 16 * .7;
      tp.fogEnd = this.horizon.radius * 16;
    }
    this.lastFogStart = fogStart;
    this.lastFogEnd = fogEnd;
    this.lastFogShape = fogShape;
    this.batch.fogShape = fogShape;
    // vanilla Lighting.setupNetherLevel: in the Nether entities are lit from above and below
    this.batch.light0 = [0.2, 1.0, -0.7];
    this.batch.light1 = dim.effects.constantAmbientLight ? [-0.2, -1.0, 0.7] : [-0.2, 1.0, 0.7];
    const mainVisible=this.world.cull(tp, rdBlocks);
    const waterVisible=!!hyper&&this.world.hasVisibleWater(tp);
    const planarVisible=waterVisible&&hyper!.dimension===0&&this.world.hasVisibleWater(tp,hyper!.reflectY);
    if (hyper) {
      hyper.reflectionAvailable=planarVisible;
      // The Nether has no directional skylight; neither its lighting nor
      // its biome-coloured volume samples a sun shadow.
      if(hyper.dimension!==1){
        hyper.beginShadow();
        this.world.drawShadow(tp, hyper.lightMatrix, 110);
      }
      if (planarVisible) {
        hyper.beginReflection();
        hyper.drawSky(true);
        const reflectedFrustum = this.reflectedFrustum;
        reflectedFrustum.setFromMatrix(hyper.reflectVP);
        const reflected = { ...tp, view: hyper.reflectView, frustum: reflectedFrustum };
        this.world.cull(reflected, rdBlocks);
        this.world.drawOpaque(reflected);
        hyper.endReflection();
      }
      hyper.beginScene();
      if(planarVisible)this.world.restoreVisible(mainVisible);
    }
    this.world.drawOpaque(tp);
    if (!e.underwater && !e.lava && !skyBlocked) this.horizon?.draw(tp, rdBlocks);
    // Full-resolution End ray marching only shades unobstructed space.
    // Keep the exact same integration, planet detail and output resolution.
    if(hyper?.dimension===2)hyper.drawSky(false,true);
    if (e.level) this.end.renderPortals(e.level.world, cam.x, cam.y, cam.z, this.proj, this.view, this.frustum, EndRenderer.shaderTime(e.level.gameTime, e.partial), !!hyper);
    if (e.level) this.renderEntities(e.level, cam, e.partial, fog, fogStart, fogEnd, e.entityOptions);
    if (e.level) {
      // (vanilla TheEndGatewayRenderer's beams, with the block entities)
      this.end.renderGatewayBeams(this.batch, e.level.world, e.level.gameTime, cam.x, cam.y, cam.z, this.frustum, e.partial);
      // (the beacon) and the beacons' beams
      this.beacons.render(this.batch, e.level.world, e.level.gameTime, cam.x, cam.y, cam.z, this.frustum, e.partial);
      this.batch.flush();
    }
    if (hyper && (waterVisible || (hyper.wetness>0.01 && !e.underwater))) {
      hyper.captureOpaque();
      if(hyper.wetness>0.01 && !e.underwater){
        this.world.drawOpaque(tp,true);
        if(waterVisible)hyper.captureOpaque();
      }
    }
    this.world.drawTranslucent(tp);
    if (this.particles) {
      this.particles.subtleNetherAmbient = !!hyper && dim.id === 'the_nether';
      this.batch.proj = this.proj;
      this.batch.view = this.view;
      this.batch.fog = [fogStart, fogEnd];
      this.batch.fogColor = fog;
      this.batch.lightmap = this.lightmap.texture;
      this.particles.render(this.batch, cam, e.partial, this.atlas.texture!);
      if (!this.particleAtlas) {
        this.particleAtlas = buildParticleAtlas(this.gl);
      }
      this.particles.spriteTexture = this.particleAtlas.texture;
      this.particles.spriteRects = this.particleAtlas.rects;
      this.particles.renderSprites(this.batch, cam, e.partial);
    }
    if (!hyper && this.cloudsEnabled && !e.underwater && !this.skipClouds && !skyBlocked && dim.effects.clouds) {
      const cc = env.cloudColor(tod, e.weather);
      this.clouds.render(this.proj, this.view, cam.x, cam.y, cam.z, e.ticks + e.partial, cc, fog, rdBlocks);
    }
    if (e.level && e.weather.rain > 0) {
      this.batch.proj = this.proj;
      this.batch.view = this.view;
      this.batch.fog = [fogStart, fogEnd];
      this.batch.fogColor = fog;
      this.batch.lightmap = this.lightmap.texture;
      const gl2 = this.gl;
      gl2.depthMask(false);
      this.weather.render(this.batch, e.level.world, cam, e.weather.rain, e.ticks, e.partial, this.fancy, !!hyper);
      gl2.depthMask(true);
    }
    if (hyper) hyper.finish(e.outputFramebuffer ?? null);
  }

  private renderEntities(level: Level, cam: Camera, partial: number, fog: [number, number, number], fogStart: number, fogEnd: number, opts?: EntityRenderOptions): void {
    const b = this.batch;
    b.proj = this.proj;
    b.view = this.view;
    b.lightmap = this.lightmap.texture;
    b.fogColor = fog;
    b.fog = [fogStart, fogEnd];
    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    this.entities.render(b, level, cam, partial, this.frustum, opts ?? { shadows: true, drawPlayer: false, distanceScale: 1 });
  }
}
