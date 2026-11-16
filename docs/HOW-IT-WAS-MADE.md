# How GeoStrands Was Made

By Charlize Pauli

GeoStrands is a hair card authoring tool that runs in the browser. You place a few guide curves on a head, and it builds textured hair cards around them, lets you comb and simulate them, and exports a mesh any engine can load. This is the story of why I built it, the decisions that shaped it, and what I learned on the way. It is a work in progress (version 0.1.2), and I mention the rough edges where they matter.

---

## The problem

Card-based hair is still the workhorse for real-time characters. Strand rendering keeps improving, but most game hair, and a lot of cinematic previs hair, is a few hundred textured quads arranged by hand. Building that by hand is slow. In a typical DCC workflow you:

1. paint or bake strand textures into an atlas,
2. model a plane, unwrap it onto one atlas region, and bend it into place,
3. duplicate it, offset it, rotate it, rescale it and repeat a few hundred times,
4. go back and redo whole sections when the art direction changes.

Larger studios avoid this with strand-to-card pipelines: they groom real strands in a dedicated tool and convert clumps into cards automatically. Those pipelines are powerful but heavy. They need a groom package, a converter and often in-house scripts. I wanted something between the two: lighter than a full groom and far less manual than placing every card yourself.

## Design goals

- **Sparse guides, dense result.** The artist draws a few guide curves, and the cards come from per-guide settings: density, width, spread, taper and length. Changing one number rebuilds the whole group.
- **Artist-friendly.** The tool should feel like the software artists already know: right-drag to orbit, Blender-style G/S/R with axis keys, Substance-style light rotation, layers, symmetry, Ctrl+Z.
- **Engine-agnostic output.** Plain meshes and textures that Unreal, Unity, Godot and Blender all read, with no plugin.
- **Real-time first, cinematic-capable.** A live budget readout for game work, plus SSAO, bloom, tone mapping and soft shadows to judge the look for cinematics and previs.
- **No install.** Open a file and start working.

## Key decisions and trade-offs

### Three.js and vanilla ES modules, no framework

The app is mostly a 3D viewport and a few 2D canvases with a lot of sliders around them. A UI framework would have added a build step and a lot of concepts while doing little for the hard parts, which are geometry, picking and canvas work. So I wrote plain ES modules: each one gets its own DOM elements by id and wires its own events. The cost is that `app.js` grew large (about 3,300 lines) and module-level state is shared freely. The benefit is that nothing sits between me and the renderer, and anyone who knows Three.js can read the code.

For the few things that need to cross module boundaries (the atlas image and regions), I wrote a tiny store with an `on` / `emit` bus in `state.js`. It is about twenty lines, and that has been enough so far.

### Vendored dependencies

Three.js r160 and the addons I use (OrbitControls, OBJLoader, GLTFExporter, the post-processing passes) are copied unmodified into `src/vendor/`. There is no package install for the app itself. esbuild is the only dev dependency, and only the release build needs it. The project builds the same way years from now, works offline, and has no risk of a transitive dependency breaking it. The trade-off is that I upgrade Three.js by hand when I choose to.

### A platform-layer abstraction

GeoStrands started inside the original desktop shell, with native file dialogs, a native menu bar and writes to real paths. Early on I put every host-specific operation behind one object, `window.hcsAPI`: open a file, save a project, export a mesh, write autosave, listen for menu events. The app only calls that interface.

That decision paid off when I moved to the browser. Porting meant writing one new file, `platform-web.js`, about 140 lines, which implements the same interface with standard web APIs: hidden file inputs for opening, object-URL downloads for saving, `localStorage` for autosave and an in-page File/Edit menu in place of the native one. I did not have to change any app module. A few features lose something in the browser (you cannot write into a chosen folder, so folder exports become individual downloads), and the interface makes those differences explicit instead of scattering them through the code.

### OBJ and glTF first

I put the most effort into the formats I could check myself: OBJ/MTL and glTF binary. OBJ is the lowest common denominator. I write real quads rather than triangle pairs, so a cleanup in a DCC is quicker. GLB carries the textures and materials in one file. FBX (ASCII) and USDA are there too. They are hand-written text formats that I have not checked in every target tool, and the UI says so. The USD guide-curve export is the honest answer for groom-style pipelines: it writes the real guide points as `BasisCurves`, not invented strand data.

### A single-file offline build

`scripts/build.mjs` bundles every module with esbuild, inlines the CSS, the icon, the platform script and even the default head OBJ as data URLs, and writes one `GeoStrands.html` of about 5 MB. You can email it, put it on a USB stick or open it on a locked-down studio machine, and it runs. The same file is deployed to GitHub Pages as the live demo.

---

## The development journey

### 1. Head, guides and the first cards

The first milestone was clicking on a head and getting a curve. Guide points come from raycasting the head mesh, and a Catmull-Rom curve smooths them for the preview. The first card builder sampled the curve evenly by arc length and placed one quad per sample.

Orientation was the first real design question. Camera-facing billboards look fine in a viewport and fall apart in an engine, where the camera moves freely. I chose a frame based on the head instead: the strand tangent defines the card's long axis, the direction from the head center to the sample defines "outward", and two cross products give a stable, orthogonal frame. Cards lie over the scalp the way hand-placed cards do. Each card is a little taller than the gap between samples (×1.35), so neighbors overlap like real card strips, and a small random sideways offset and twist (spread) breaks up the regular pattern.

### 2. Two-sided geometry

Card hair has to be visible from both sides, and the obvious fix, a double-sided material flag, does not survive the trip through OBJ. There is no standard way to mark it there. So I build the back face as real geometry: a duplicated plane with flipped normals and reversed winding. This doubles the triangle count, and the budget dashboard counts it honestly because it measures the actual index buffers.

That led to a nice detail in export. The mesh is made of plane grids, so each pair of triangles shares a diagonal. The OBJ and FBX/USD writers find the shared edge and rebuild a clean quad that follows the first triangle's own winding, so the reversed back faces stay reversed.

### 3. Atlas regions

The Atlas Editor lets you drag rectangles on the atlas image and name them. Each guide picks a region, and its card UVs are remapped into that rectangle. Region coordinates are measured from the top of the image, like a painting program, and the conversion to texture space happens in one place (`remapUVs`). A flip checkbox covers atlases authored the other way up.

### 4. Grooming: shape modifiers, comb and symmetry

Hand-placed points only get you so far, so I added modifiers that change the curve itself rather than the texture: bend, curl, wave ("noise"), scatter into tufts, and clump toward a shared center path. They all work in a frame built per guide from its overall direction and the head's outward direction, so a curl looks the same on the crown as it does at the temple.

The comb tool pushes nearby points with the mouse movement, with linear falloff inside a brush radius. Each combed point is also eased 15% back toward the scalp surface, so you cannot comb strands through the head or float them off it. Symmetry Mode pairs each guide with a mirror and reflects every placement, comb stroke and drag across the head's center plane.

### 5. Physics

For a quick check of how hair would hang, I added a small verlet simulation: pinned roots, gravity, a damping factor, three passes of distance constraints and head collision. The detail that matters most is when rest lengths are taken. If they were recomputed inside the simulation step, the constraints would have nothing to pull back toward. So they are captured only after authoring actions, and the simulation always relaxes toward the shape the artist made.

Head collision gave me a second lesson. A sphere formula is fine for the placeholder but wrong for any real head, so collision casts a ray from the head center outward and pushes points back to the first surface hit. It works for any reasonably round imported mesh. It also needs the head material to be double-sided, because the ray starts inside the mesh.

### 6. Manual Edit

The density-driven workflow is the core, but artists always want to nudge a single card. Manual Edit lets you click a card, click again to pick a vertex, edge or face, and drag it. You can also use Blender-style G/S/R with X/Y/Z axis constraints, subdivide a card into rows, and let subdivided cards sag under their own small gravity sim.

Picking was harder than it looked. With dozens of overlapping cards, the second click (meant for a vertex) often hit a neighboring card instead. The fix was to test the selected card first and on its own. A second bug was a modal transform that got stuck when the user clicked a side-panel button in the middle of a drag, which made it look as if selection had broken. Now any click outside the canvas cancels the transform.

### 7. Texture Canva, Bake and Export maps

I wanted the strand textures to come from the same tool, so the second half of GeoStrands is a 2D workbench: brushes with width profiles, a pen tool, fills, gradient shapes, and procedural modifiers (root-tip color, highlight bands, opacity falloff, streak noise, hue jitter). The key design choice is a non-destructive stack. The raw paint lives in its own canvas, and the composite is rebuilt from it each time, so modifiers never stack on their own output.

For texture exports I stuck to maps I can honestly derive from a flat painting: alpha, a luminance-based height map, a root-to-tip ramp, translucency as inverted alpha, and a **real** flow map. Every brush dab and pen segment records its direction into a separate RG buffer, so the flow map shows the way you actually painted. A channel-packing export builds engine-ready mask textures. I left out strand ID, normal and specular maps on purpose, because a 2D canvas has no data to build them from.

### 8. Rendering and the look

The default render path is plain and fast. When you turn on SSAO or bloom, the frame goes through an `EffectComposer`, and turning them off returns to the plain path. The Hair and Render tabs each have their own preview viewport with independent orbit controls, rendering the same scene, so you can study the look without losing your working camera. The Render tab has its own composer, so its preview matches the final settings.

### 9. Safety nets: undo, autosave, budget

Undo stores snapshots: guide and layer state is serialized before each action, and a whole slider drag or comb stroke counts as one step. The Atlas and Texture tabs keep their own stacks, and Ctrl+Z goes to the one for the tab you are on. Autosave writes to its own slot and never overwrites the file you saved yourself. The budget dashboard reports cards, quads, triangles, vertices and atlas memory (RGBA8 plus mip chain) against a target you set, so the game budget stays in view while you work.

### 10. Going browser-native

The last big step was the move from the original desktop shell to a standalone web build. Thanks to the platform layer, most of the work went into the build script, not the app: inlining assets, putting the head mesh in a data URL so `file://` works, and making sure nothing in the bundle needs a server.

---

## Challenges worth remembering

- **Two merge functions, two assumptions.** The head importer joins non-indexed meshes, and the card builder joins indexed ones. A merge that ignores index offsets would scramble the triangles of indexed card geometry without any error, so there are two functions, each with its assumption written down.
- **Card size in the viewport.** Real card widths are tiny at head scale, so the viewport scales cards up by an adjustable amount (6× by default) to keep them visible. Every exporter resets that scale before writing, so exported sizes are true.
- **Keeping cards attached during simulation.** Cards are rebuilt on the moving curve every frame, and each keeps its original random offset and twist, so they follow the strand without flickering.
- **Checking exports with validators.** I ran the GLB through the Khronos glTF validator and the USD files through the OpenUSD validators, and fixed what they reported until both came back clean.
- **Outlines and picking.** Card outlines and selection highlights are children of the cards, so raycasting is turned off on them. Otherwise they took clicks meant for the card surface.

## What's next

GeoStrands is usable but unfinished. The work I care most about:

1. **Continuous card strips** with UVs that run the length of the atlas region, and a proper twist control along each guide.
2. **Saving everything**: Manual Edit changes in the project file and in undo. Symmetry pairs are already saved.
3. **Better sorting for cinematic renders**, such as an alpha-to-coverage path.
4. **Better import**: a real PSD decoder and more than one atlas per project.
5. **Faster physics** with an acceleration structure for head collision, and more controls (wind, per-guide stiffness).
6. **FBX checked in Autodesk tools and Blender**, with a texture node, and card LODs for game budgets.

If you try it, the sample project in `examples/` is the quickest way in: open it from File > Open Project, orbit with right-drag, and turn on physics with Space.
