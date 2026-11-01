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
| Canonical far generation, cross-chunk decoration | DH world-generator wrappers (Minecraft-specific) | chunkWorker horizon job, existing World.addChunk | Integrated; runtime validation pending |
| Persistent derived source | FullDataSourceProviderV2, SQLite (platform-specific) | store.ts, IndexedDB | Integrated; persistence/reload validation pending |
| Dedicated distant rendering | LodRenderer, ColumnRenderBufferBuilder (OpenGL-specific) | renderer.ts, mesh.ts, WebGL2 | Runtime validation pending |
| DH multi-slice vertical quality reducer, greedy quad coalescing, GPU buffer arena | RenderDataPointReducingList, LodQuadBuilder, buffers | Not yet ported | Outstanding; performance parity NOT established |
| Multi-device visual/performance parity, distant pre-generation | DH generation queues, renderer | Not yet verified | Outstanding |

Default requested horizon is 128 chunks (2048 blocks), configurable with
`?horizon=32..512`; `?horizon=0` disables this system. This is a requested radius,
not proof of complete pre-generated coverage. Only real generated/saved terrain
is rendered. New data builds gradually; there is no fabricated heightmap fallback.
Full chunk generation currently costs substantially more than render-only cached
LOD retrieval. Raw distant chunks are discarded; data and render memory are bounded.
Distant generation is lower priority than near jobs and has only one job pending.

The parent/child GPU handoff does not imply pixel-identical near/far shading.
The LOD shader uses atlas-average colours and the existing lightmap; hyperShader
volumetrics, reflections and shadows are not yet matched. Renderer integration,
near-boundary coverage, world changes, reload and long-distance memory must pass
runtime tests before merging to main or claiming a finished DH equivalent.

Validation: `npm run build`; `node scripts/horizon-check.mjs`;
GitHub Actions `Horizon port validation` runs a software WebGL2 smoke scenario.
Software results cannot establish Android or hardware GPU FPS.
