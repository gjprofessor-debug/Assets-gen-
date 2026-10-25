# FORM — 3D Mid-Poly Asset Generator & Web Viewer

A Blender-free procedural asset workshop: **Python generates real meshes**, **Three.js previews them**, and **GitHub Actions publishes the static site to GitHub Pages**. Three ready-to-use humanoids (800, 1,500 and 3,000 triangles) are included, with both GLB and OBJ downloads.

## Project structure

```text
.
├── .github/
│   └── workflows/
│       └── deploy.yml              # Generate, test, optionally persist, deploy
├── .gitignore
├── LICENSE
├── README.md
├── requirements.txt                # Pinned Python 3.11 dependencies
├── scripts/
│   └── generate_asset.py           # Procedural mesh + QEM + color + export
├── tests/
│   └── test_generator.py           # Geometry and export integration tests
└── public/                         # Entire Pages deployment artifact
    ├── .nojekyll
    ├── index.html                  # Responsive application shell + import map
    ├── styles.css                  # Workshop UI, including mobile layouts
    ├── app.js                      # Three.js viewer and interactive controls
    ├── config.json                 # Repository links, set automatically in CI
    └── assets/
        ├── manifest.json           # Versioned asset gallery metadata
        └── models/
            ├── atlas-t-pose.glb
            ├── atlas-t-pose.obj
            ├── atlas-study.glb
            ├── atlas-study.obj
            ├── atlas-refined.glb
            └── atlas-refined.obj
```

## Run locally

Requires **Python 3.11**. No Blender, Node.js, graphics hardware, API keys, or paid generation services are needed for generation.

```bash
python3.11 -m venv .venv
source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install -r requirements.txt
python scripts/generate_asset.py --name "My First Humanoid" --target-faces 1500
python -m http.server 8000 --bind 0.0.0.0 --directory public
```

Visit **http://localhost:8000**. Do not open `index.html` through `file://`; ES modules, fetch, and GLB loading need HTTP. All browser-facing asset paths are relative, so project Pages paths and proxied previews work without modification.

The browser needs WebGL and network access to the pinned Three.js CDN, Tailwind's CDN, and Google Fonts. Core layout styles are local and fall back to system fonts if Google Fonts is unavailable. Three.js itself must load for the renderer to work. Generation and downloads use no external textures.

## Deploy to GitHub Pages

1. Put these files on the repository's **`main`** branch, or merge the implementation branch into `main`.
2. In **Settings → Pages → Build and deployment → Source**, select **GitHub Actions**. This is GitHub's required one-time repository setting; a workflow cannot assume an unconfigured Pages site is enabled.
3. Ensure Actions is enabled. The workflow explicitly requests `contents: write`, `pages: write`, and `id-token: write`. Organization policy must permit these permissions and the listed official actions.
4. Push to `main`, or select **Actions → Generate assets & deploy Pages → Run workflow**.
5. The deployment URL is shown in the `github-pages` environment and the deploy job summary. For this repository the expected project URL is `https://gjprofessor-debug.github.io/Assets-gen-/`.

`actions/configure-pages@v5`, `actions/upload-pages-artifact@v3`, and `actions/deploy-pages@v4` publish **only `public/`**. A separate build and deploy job ensures failed generation/tests never replace a working deployment. The workflow serializes all runs to avoid concurrent manifest writes and deployment races.

### Generate from the Actions UI

The **Generate new asset** button opens the repository workflow page. Sign into GitHub with write access, select **Run workflow**, and choose:

| Input | Default | Behavior |
|---|---|---|
| `asset_name` | `Atlas / T-Pose` | Display name; sanitized into a filename. Same slug replaces the old asset. |
| `target_faces` | `1500` | Choice of `800`, `1500`, or `3000` triangles. |
| `flat_shading` | `true` | False exports shared vertices with smooth normals. |
| `persist_assets` | `true` | Commit both GLB/OBJ, the manifest, and repository links to the triggering branch. |

The UI link intentionally opens the workflow, not a raw dispatch API: a static public site must **never embed a GitHub token**. GitHub only exposes manual dispatch normally after the workflow exists on the default branch. On a new repository, merge it there first.

Persistence uses the ephemeral `GITHUB_TOKEN`, a bot commit, and `[skip ci]`. It never commits requirements, secrets, or build caches. Push-triggered builds generate/deploy without writing back. Disable persistence when branch protection prevents bot pushes; models still appear in that deployment, but will not survive the next clean build unless committed. To preserve an expanding library, commit generated models or enable the manual persistence option.

If dispatching a non-default branch, its changes will deploy too; allow that branch in the `github-pages` environment's deployment rules if needed. Branch protection or repository rules can reject the optional commit. The job fails visibly rather than silently losing generated assets. A human pushing during a run can similarly cause a safe non-fast-forward rejection; rerun against the latest branch tip.

Repository links default to this repository in `public/config.json`; CI rewrites them from `github.repository`, so forks automatically point to their own workflows and source.

## Generator CLI

```bash
# Default: 1,500 triangles, flat shading, stylized T-pose
python scripts/generate_asset.py

# Explicit preset and face budget
python scripts/generate_asset.py \
  --name "Runner 800" --target-faces 800 \
  --preset stylized-tpose --flat-shade

# Smooth export
python scripts/generate_asset.py \
  --name "Runner Smooth" --target-faces 3000 --no-flat-shade

# Import a local mesh (OBJ, GLB, STL, PLY, etc. as supported by Trimesh)
python scripts/generate_asset.py \
  --input ./public/assets/models/atlas-refined.glb \
  --name "Atlas Remixed" --target-faces 1500

# Isolated output folder for a build or experiment
python scripts/generate_asset.py --output-dir .cache/experiment --name "Study"

python scripts/generate_asset.py --help
```

| Argument | Default | Notes |
|---|---|---|
| `--input` | None | Imports geometry instead of generating a humanoid. Scenes are baked/concatenated by Trimesh. |
| `--name` | `Atlas / T-Pose` | 1–100 characters, must produce a nonempty ASCII alphanumeric slug. |
| `--target-faces` | `1500` | **Even integer, 100–100,000.** |
| `--flat-shade` / `--no-flat-shade` | Enabled | `argparse.BooleanOptionalAction`; no string truthiness bugs. |
| `--preset` | `stylized-tpose` | Built-in clean, connected humanoid preset. |
| `--output-dir` | `public/assets` | Contains `models/` and `manifest.json`. |

### Mesh construction and correctness

1. **Union primitives:** ellipsoids and capsules define a symmetric humanoid including head, neck, torso, upper/lower arms, hands, pelvis, thighs, shins, and feet. A sampled implicit union is polygonized using an in-repository, NumPy marching-tetrahedra implementation. This is **one welded, watertight exterior**, not a collection of intersecting primitive shells. Internal faces are never emitted. No marching-cubes or boolean-engine dependency is needed.
2. **Condition geometry:** remove degenerate faces, repair winding/normals, verify a single closed shell, then use two Taubin smoothing passes to regularize skinny extraction triangles with minimal shrinkage. Coordinates are Y-up, in approximately meter units, with the feet at ground height. Sampling and simplification can introduce small left/right differences; exact mirrored topology is not promised.
3. **Quadric-error decimation:** use current Trimesh's `simplify_quadric_decimation(face_count=…, aggression=7)`, backed by `fast-simplification`. The old API name `simplify_quadratic_decimation` is not available in the pinned version. Bounded retries handle a stalled threshold pass. If the result undershoots by an even number, centroid-split the largest triangles, adding exactly two faces per split **without changing the surface**. If a source has fewer faces than requested, this same refinement increases its budget; it does not invent geometric detail. Decimation prioritizes, but cannot mathematically guarantee, an unchanged silhouette at very small budgets.
4. **Faceted shading:** flat exports call `unmerge_vertices()`, assign face-uniform vertex colors, and explicitly repeat each face normal onto its three vertices. The final vertex count is therefore **3 × triangle count**. The geometry is geometrically closed but deliberately disconnected by index in the flat export. Smooth exports retain shared indices.
5. **Color:** skin, dark athletic shirt, shorts, and shoes use RGBA vertex colors. Imported meshes get a neutral vertex-color palette; existing UV textures, rigs, animation, and material assignments are not preserved. This tool is for static mesh assets, not lossless scene conversion.
6. **Export and catalog:** validate the GLB structure with `pygltflib`, write GLB and OBJ using per-file atomic replacement, then atomically upsert the manifest by slug. The manifest is written last. Files with the same slug are intentionally overwritten; do not run multiple local writers concurrently against the same output folder.

**Why only even targets?** A closed triangulated 2-manifold has `3F = 2E`, so `F` must be even. Returning 1,501 faces would require an open boundary, nonmanifold geometry, or a dishonest count. Odd targets fail clearly instead. The imported input must also have an even triangle count. Arbitrary imported topology is not automatically repaired into a closed manifold.

OBJ supports mesh geometry and normals reliably, but vertex colors are a widely used **extension**, not a guarantee in every OBJ importer. Use GLB when you need portable, embedded colors. Neither export needs an MTL or texture sidecar.

`networkx` is explicitly included because Trimesh's winding repair and connected-component checks use it. The other pinned dependencies are NumPy, SciPy, Trimesh, fast-simplification, and pygltflib. There is no system Blender/OpenGL requirement for the generator; Python wheels for the listed packages are installed by pip.

## Interactive viewer

- Searchable, manifest-driven asset gallery with a selected-state silhouette illustration.
- ES modules with a **pinned Three.js 0.170.0 import map**. `GLTFLoader` and `OrbitControls` resolve the same `three` instance.
- Perspective camera that fits models on selection and responsive resize, damped orbit/pan/zoom, studio lighting, soft shadows, grid, and orientation guide.
- Live **rendered** vertex and triangle counts (wire overlays are excluded), rather than blindly trusting manifest counts.
- Wireframe overlay, flat/smooth shading, opt-in auto-rotation, background presets/custom color, non-destructive material tint and reset.
- Smooth mode averages area-weighted normals by position, so it works on flat exports with duplicated vertices too. It does not simply toggle a material flag on still-disconnected normals.
- GLB/OBJ downloads always serve the original files, unaffected by preview changes. Imported models are centered/scaled **only in the viewer**.
- Direct selection with URL hashes, e.g. `#atlas-study`. **F** fits the camera; **/** focuses search.
- Mobile layout, labeled controls, keyboard focus states, reduced-motion-aware opt-in rotation, load/error states, WebGL-unavailable download fallback, and resource disposal when switching assets.

The sidebar illustrations are lightweight procedural SVG silhouettes, not individual model screenshots. The main viewport always renders the selected real GLB. The viewer is intended for static mesh exports from this generator; skinned/animated scenes and arbitrary imported material groups are out of scope.

### Manifest schema

`public/assets/manifest.json` has `version: 1` and an `assets` array. Each record contains:

- `id`: safe slug, used for replacement and deep links.
- `name`: original display name (inserted via `textContent`, never interpreted as HTML).
- `filename`, `objFilename`: paths relative to `public/assets/`.
- `vertices`, `faces`: exported geometry counts.
- `flatShading`, `preset`: generation settings.
- `generatedAt`: UTC ISO-8601 timestamp with timezone.
- `bytes`: binary GLB size.

The viewer restricts model URLs to `models/<safe-slug>.glb` or `.obj`. No localhost API, server-side runtime, private credential, or absolute domain is required.

## Tests and validation

```bash
python -m unittest discover -s tests -v
# Optional, if Node.js is available:
node --input-type=module --check < public/app.js
```

The eight integration tests cover exact budgets at 100/800/1,500/3,000 triangles, connected/watertight/winding-consistent geometry before flat splitting, approximate symmetry, face normals, palette colors, subdivision volume preservation, invalid inputs, input-mesh loading, safe filenames, both exports, GLB attributes, UTC metadata, and manifest upserts. CI runs these before generation and deployment.

For browser verification: select all three assets, change each display control, inspect smooth shading on a flat export, reset tint/camera, search for a name, use both download links, and resize to a narrow phone viewport. On failure inspect the visible message, browser console, and Network panel. You can run the generator/tests entirely offline after installing requirements; the viewer's external ES modules need network access.

## Troubleshooting

- **Pages returns 404:** select GitHub Actions as the Pages source, confirm the deploy job passed, and use the project path (including `/Assets-gen-/`), not the domain root.
- **No Run workflow button:** put the workflow on the default branch and sign in with repository write access.
- **Bot commit denied:** disable `persist_assets`, or allow bot writes under your repository rules. Workflow permission declarations cannot override organization policy or branch protection.
- **Blank 3D view:** check that WebGL/hardware acceleration is enabled and `cdn.jsdelivr.net` is reachable; look for CDN or GLB network failures. Serve via HTTP, not `file://`.
- **Odd triangle budget rejected:** choose an even count; the limit is intentional for closed triangle surfaces.
- **Same asset replaced:** two names can sanitize to the same slug; use distinct alphanumeric names to keep separate assets.

## License

MIT. Included procedurally generated sample assets are also provided under MIT.
