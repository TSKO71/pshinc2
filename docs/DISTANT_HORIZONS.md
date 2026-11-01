# Distant Horizons port — work in progress

Reference: https://gitlab.com/distant-horizons-team/distant-horizons-core
Inspected revision: `30ca745a802c188f5c57e50477a2a306ed5cbaa4` (2026-11-01).
Original copyright: James Seibel and Distant Horizons contributors.
`src/horizon/data.ts` is an LGPL-3.0-only TypeScript adaptation. License texts
are in `licenses/distant-horizons`. The application remains separately licensed.
Source and modifications are distributed together in this repository; rebuild
with `npm ci && npm run build` to replace the adapted module.

## Source mapping and acceptance

| Mechanism | Actual DH source | Destination | Status |
|---|---|---|---|
| Vertical full-data runs (material/biome, Y range, light) | FullDataPointUtil; FullDataSourceV2 | source.ts, data.ts | Implemented; no height-only terrain |
| Four-column reduction; visible ID majority; light only from winner | FullDataSourceV2.mergeInputTwoByTwoDataColumn | mergeColumns | Voxel oracle: 200 cases pass |
| Propagate updates one level at a time | FullDataSourceV2.updateFromOneBelowDetailLevel | mergeTiles, Horizon.accept | Negative coordinate tests pass |
| Log-distance quality selection | LodQuadTree.calcDetailLevelFromDistance; MEDIUM enum | detailLevel | Boundary tests pass |
| Parent stays until all four children render | LodQuadTree.onDetailLevelTooLow | selectTiles | Partial/complete readiness tests pass |
| Direct far-column generation | DH WorldGenerationQueue / generateLod model | ChunkGenerator.sampleLodColumn, captureGeneratedTile | Integrated: same density router, noodle caves, aquifers, ore-vein fields, biome and surface rules; no full chunk allocation |
| Persistent derived source | FullDataSourceProviderV2, SQLite (platform-specific) | store.ts, IndexedDB | Integrated; persistence/reload validation pending |
| Dedicated distant rendering | LodRenderer, ColumnRenderBufferBuilder (OpenGL-specific) | renderer.ts, mesh.ts, WebGL2 | Indexed packed GPU vertices, frustum culling and near-chunk coverage mask; runtime validation in progress |
| Vertical slice limit, small-segment reduction, highest/lowest reduce-to-one | RenderDataPointReducingList; MEDIUM vertical quality | reduce.ts | Implemented for opaque LOD mode; unit tests pass |
| Greedy quad coalescing and indexed packed GPU vertices | LodQuadBuilder.mergeQuads; BufferQuad.tryMerge | mesh.ts, renderer.ts | Solid cuboid test reduces to six quads; packed 12-byte vertices |
| Packed 64-bit full-data runs | FullDataPointUtil | packColumn/unpackColumn | Roundtrip tests pass; 2 uint32 words per run |
| Multi-device visual/performance parity, distant pre-generation | DH generation queues, renderer | Not yet verified | Outstanding |

Default requested horizon is 128 chunks (2048 blocks), configurable with
`?horizon=32..512`; `?horizon=0` disables this system. This is a requested radius,
not proof of complete pre-generated coverage. Far tiles are sampled directly from
the same world density generator at their target detail: full chunk buffers,
lighting, carvers and placed features are not generated for every distant sample.
The sample includes the native noise terrain, noodle caves, aquifers, ore-vein
fields, biome selection and surface rules. When a real chunk is loaded, its exact
block, biome and light columns replace the generated sample and propagate to its
coarse ancestors. Structures and placed features beyond the loaded area therefore
remain absent until their chunks are visited; this is an explicit difference from
full chunk generation, not a fabricated heightmap fallback.

Tiles currently hold 16 x 16 columns, smaller than Distant Horizons' 64 x 64
FullDataSource sections. The data reduction and hierarchy rules are ported, but
this smaller section footprint increases tile bookkeeping and potential draw calls.
Worker jobs are bounded by the shared worker pool and duplicate coordinates are
suppressed. IndexedDB stores derived tiles; memory and GPU residency are bounded.

The parent/child GPU handoff does not imply pixel-identical near/far shading.
The LOD shader uses atlas-average colours and the existing lightmap; hyperShader
volumetrics, reflections and shadows are not yet matched. Renderer integration,
near-boundary coverage, world changes, reload and long-distance memory must pass
runtime tests before merging to main or claiming a finished DH equivalent.

Validation: `npm run build`; `node scripts/horizon-check.mjs` (200 voxel-oracle
reductions, generator biome/surface parity, parent-quadrant propagation and mesh
checks); GitHub Actions `Horizon port validation` runs a software WebGL2 smoke
scenario. Software results cannot establish Android or hardware GPU FPS.
