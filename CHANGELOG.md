# Changelog

All notable changes to GeoStrands are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses [Semantic Versioning](https://semver.org/).

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

[0.1.1]: https://github.com/Eviee556/GeoStrands/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Eviee556/GeoStrands/releases/tag/v0.1.0
