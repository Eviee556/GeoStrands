# Changelog

All notable changes to GeoStrands are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.3] - 2026-11-16

### Added

- Automated end-to-end test (`npm test`), run on every push by GitHub Actions. It opens the sample project in a headless browser, exports every format and validates each file: glTF with the Khronos validator, OBJ and FBX with three.js loaders, plus USD structure and non-blank texture maps.
- FBX exports now carry the albedo texture (`hair-cards_fbx_albedo.png`, written next to the `.fbx`).

### Changed

- Faster physics: cards update their geometry in place instead of being rebuilt every frame, and the simulation loop no longer allocates per point.
- Head raycasts (physics collision, Place, Comb, Drag) use a bounding volume hierarchy from three-mesh-bvh. On the sample project a physics step drops from about 330 ms to 5 ms, with identical results.

### Fixed

- Undoing an atlas region delete restores the guides that used it. **Clear All** regions now resets guides to "none" and can be undone.
- The Hair tab's card count updates after opening a project, regenerating, deleting or undoing.
- The ink and textured brush styles are deterministic: the live preview matches the committed stroke, and the same stroke always paints the same pixels.
- Cancelling a pen stroke with Esc also removes its lines from the flow map.
- Removed a browser performance warning about repeated canvas readback.

## [0.1.2] - 2026-11-16

### Fixed

- Card back faces in OBJ, FBX and USD exports now face the right way. Previously both sides faced forward, so cards were invisible from behind in other tools.
- USD exports declare meters as their unit, so meshes no longer import 100× too small. They also use flat (non-subdivided), double-sided cards with cutout alpha. Both the mesh and the guide-curve files now pass the OpenUSD validators.
- USD guide curves now have a strand width instead of a 1-meter default.
- glTF exports pass the Khronos glTF validator with zero errors and zero warnings.
- FBX exports include the scene connection and definitions that DCC tools expect.
- Texture map export (simple and channel-packed) uses the loaded atlas when nothing is painted in Texture Canva, instead of writing blank images.
- OBJ+MTL and USD exports no longer overwrite each other's texture file. USD now writes `hair-cards_usd_albedo.png`.
- Undo no longer brings back guides from a previous project after New Project or Open Project.
- Symmetry links between mirrored guides are kept through save, load and undo.
- Deleting an atlas region updates the guides that use it, instead of silently shifting them to the wrong region.
- Flip V now flips each card's texture within its own atlas region.
- Card outlines follow cards after combing and physics, and manual card rotations are no longer lost.
- The stats overlay also shows in the Render tab.
- The Render tab's settings column scrolls on its own, so the preview stays in view.

## [0.1.1] - 2026-11-15

### Fixed

- Opening a project now shows textured cards right away. You no longer need to select each layer and press Regenerate Cards after opening.
- glTF/GLB export now writes cutout (masked) alpha with a 0.35 cutoff instead of blended alpha, so card hair imports into engines without sorting problems.
- Hair tab tint, emissive and roughness settings are kept when you press Regenerate Cards, undo, or open a project.
- The Atlas slice dropdown shows "— none (flat gray) —" for new guides instead of an empty box.
- Guides created with Scatter get their cards immediately.
- In Manual Edit, dragging and G/S/R on an unsubdivided card now move both sides of the card, not just the front.
- Texture Canva noise, dot noise and hue jitter give the same result every time, so exported textures are reproducible.
- Fast brush strokes no longer leave gaps between dabs. Semi-transparent brush styles look slightly denser as a result.
- The flow map now includes the first segment of each brush stroke.
- Undo in Texture Canva also restores the flow map.

## [0.1.0] - 2026-11-15

### Added

- First public release of GeoStrands, a hair card authoring tool that runs in the browser or as a standalone app.
- Guide curves, density-driven card generation, comb and drag physics, Manual Edit, Texture Canva, Atlas Editor, Bake & Colors, Hair and Render tabs, and export to OBJ/MTL, glTF/GLB, FBX and USD.
- A single-file offline build that opens from disk with no server.
- A Windows launcher.
- Documentation: tutorials, examples, technical reference and a making-of write-up.

[0.1.3]: https://github.com/Eviee556/GeoStrands/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/Eviee556/GeoStrands/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/Eviee556/GeoStrands/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Eviee556/GeoStrands/releases/tag/v0.1.0
