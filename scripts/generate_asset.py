#!/usr/bin/env python3
"""Generate welded, vertex-colored, Y-up mid-poly assets, without Blender."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import tempfile

import numpy as np
from pygltflib import GLTF2
import trimesh

ROOT = Path(__file__).resolve().parents[1]


def humanoid() -> trimesh.Trimesh:
    """Polygonize a union of symmetric implicit primitives with marching tetrahedra.

    Shared tetrahedral edges are welded after extraction. Unlike concatenated
    primitives this creates a single closed shell, including the shoulder/hip joins.
    """
    step = 0.035
    axes = [np.arange(a, b, step) for a, b in
            [(-1.4, 1.41), (-0.15, 2.31), (-0.46, 0.61)]]
    grid = np.stack(np.meshgrid(*axes, indexing="ij"), axis=-1)
    field = np.full(grid.shape[:-1], np.inf)

    def ellipsoid(center, radii):
        nonlocal field
        radii = np.asarray(radii)
        distance = (np.linalg.norm((grid - center) / radii, axis=-1) - 1) * min(radii)
        field = np.minimum(field, distance)

    def capsule(a, b, radius):
        nonlocal field
        a, b = np.asarray(a), np.asarray(b)
        delta = b - a
        t = np.clip(np.sum((grid - a) * delta, axis=-1) / np.dot(delta, delta), 0, 1)
        field = np.minimum(field, np.linalg.norm(grid - a - t[..., None] * delta, axis=-1) - radius)

    ellipsoid((0, 1.32, 0), (0.31, 0.43, 0.17))  # chest
    ellipsoid((0, 0.97, 0), (0.27, 0.23, 0.18))  # pelvis
    capsule((0, 1.6, 0), (0, 1.86, 0), 0.105)
    ellipsoid((0, 1.99, 0.012), (0.18, 0.24, 0.18))
    for side in (-1, 1):
        capsule((side * 0.22, 1.55, 0), (side * 0.69, 1.55, 0), 0.112)
        capsule((side * 0.64, 1.55, 0), (side * 1.02, 1.55, 0), 0.082)
        ellipsoid((side * 1.12, 1.55, 0), (0.16, 0.065, 0.1))
        capsule((side * 0.155, 0.94, 0), (side * 0.18, 0.54, 0), 0.123)
        capsule((side * 0.18, 0.53, 0), (side * 0.18, 0.17, 0), 0.095)
        ellipsoid((side * 0.18, 0.095, 0.085), (0.115, 0.095, 0.225))

    corners = np.array([[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
                        [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]])
    shape = np.array(field.shape) - 1
    values = np.stack([field[x:x+shape[0], y:y+shape[1], z:z+shape[2]].ravel()
                       for x, y, z in corners], axis=1)
    active = (values.min(axis=1) < 0) & (values.max(axis=1) >= 0)
    origins = grid[:-1, :-1, :-1].reshape(-1, 3)[active]
    values = values[active]
    positions = origins[:, None, :] + corners[None, :, :] * step
    triangles = []
    for tet in ([0, 5, 1, 6], [0, 1, 2, 6], [0, 2, 3, 6],
                [0, 3, 7, 6], [0, 7, 4, 6], [0, 4, 5, 6]):
        v, p = values[:, tet], positions[:, tet]
        masks = np.sum((v < 0) * (1 << np.arange(4)), axis=1)
        for mask in range(1, 15):
            rows = masks == mask
            if not rows.any():
                continue
            inside = [i for i in range(4) if mask & (1 << i)]
            outside = [i for i in range(4) if not mask & (1 << i)]

            def edge(i, j):
                t = v[rows, i] / (v[rows, i] - v[rows, j])
                return p[rows, i] + t[:, None] * (p[rows, j] - p[rows, i])

            if len(inside) == 1 or len(outside) == 1:
                a, others = (inside[0], outside) if len(inside) == 1 else (outside[0], inside)
                triangles.append(np.stack([edge(a, b) for b in others], axis=1))
            else:
                a, b = inside
                c, d = outside
                ac, ad, bc, bd = edge(a, c), edge(a, d), edge(b, c), edge(b, d)
                triangles.extend([np.stack([ac, ad, bc], axis=1), np.stack([ad, bd, bc], axis=1)])
    vertices = np.concatenate(triangles).reshape(-1, 3)
    mesh = trimesh.Trimesh(vertices=vertices, faces=np.arange(len(vertices)).reshape(-1, 3), process=True)
    mesh.update_faces(mesh.nondegenerate_faces())
    mesh.remove_unreferenced_vertices()
    trimesh.repair.fix_normals(mesh)
    if not mesh.is_watertight or len(mesh.split()) != 1:
        raise RuntimeError("Procedural surface is not a single closed shell")
    # Two volume-preserving Taubin passes regularize tiny tetrahedral slivers
    # so QEM can collapse them without flip rejection or non-manifold pinches.
    trimesh.smoothing.filter_taubin(mesh, iterations=2)
    mesh.vertices[:, 1] -= mesh.bounds[0, 1]
    return mesh


def exact_faces(mesh: trimesh.Trimesh, target: int) -> trimesh.Trimesh:
    """Quadric collapse followed by exact, silhouette-neutral face refinement."""
    if target < 100 or target > 100_000 or target % 2:
        raise ValueError("target-faces must be even and between 100 and 100000; closed triangle meshes have even face counts")
    if len(mesh.faces) % 2:
        raise ValueError("Input must have an even triangle count (repair open input boundaries first)")
    was_closed = mesh.is_watertight
    # Multiple bounded passes let QEM rebuild its error thresholds after a pass
    # stalls on the dense, welded marching-tetrahedron surface.
    for _ in range(8):
        if len(mesh.faces) <= target:
            break
        previous = len(mesh.faces)
        # Older Trimesh called this simplify_quadratic_decimation.
        mesh = mesh.simplify_quadric_decimation(face_count=target, aggression=7)
        if len(mesh.faces) == previous:
            break
    if len(mesh.faces) > target or (target - len(mesh.faces)) % 2:
        raise RuntimeError(f"Decimator could not reach compatible budget: {len(mesh.faces)} / {target}")
    # QEM may stop below its requested budget. Splitting a face into three adds
    # exactly two triangles without moving the surface or breaking edge adjacency.
    while len(mesh.faces) < target:
        count = min((target - len(mesh.faces)) // 2, len(mesh.faces))
        selected = np.argsort(mesh.area_faces)[-count:]
        faces = mesh.faces[selected]
        centers = mesh.vertices[faces].mean(axis=1)
        ids = np.arange(len(mesh.vertices), len(mesh.vertices) + count)
        new = np.concatenate([np.column_stack([faces[:, i], faces[:, (i + 1) % 3], ids]) for i in range(3)])
        mesh = trimesh.Trimesh(vertices=np.vstack([mesh.vertices, centers]),
                               faces=np.vstack([np.delete(mesh.faces, selected, axis=0), new]), process=False)
    if was_closed and not mesh.is_watertight:
        raise RuntimeError("Decimation would break the closed surface; use a larger face budget")
    if not np.isfinite(mesh.vertices).all() or not mesh.is_winding_consistent:
        raise RuntimeError("Decimation produced invalid coordinates or inconsistent winding")
    return mesh


def paint(mesh: trimesh.Trimesh, procedural: bool, flat: bool) -> None:
    if flat:
        mesh.unmerge_vertices()
    points = mesh.triangles_center if flat else mesh.vertices
    colors = np.tile([185, 199, 221, 255], (len(points), 1)).astype(np.uint8)
    if procedural:
        x, y = np.abs(points[:, 0]), points[:, 1]
        colors[:] = [205, 151, 114, 255]
        shirt = (y > 1.02) & (y < 1.7) & (x < 0.49)
        shorts = (y > 0.68) & (y <= 1.05)
        shoes = y < 0.2
        colors[shirt] = [39, 55, 72, 255]
        colors[shorts] = [28, 37, 53, 255]
        colors[shoes] = [48, 62, 80, 255]
    mesh.visual.vertex_colors = np.repeat(colors, 3, axis=0) if flat else colors
    # Explicit normals are exported to glTF; duplicated vertices enforce hard edges.
    if flat:
        mesh.vertex_normals = np.repeat(mesh.face_normals, 3, axis=0)
    else:
        _ = mesh.vertex_normals


def atomic_write(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
        temp = Path(handle.name)
        handle.write(data)
    try:
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def generate(args) -> dict:
    name = args.name.strip()
    slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
    if not slug or len(name) > 100:
        raise ValueError("name must contain letters or numbers and be at most 100 characters")
    mesh = trimesh.load(args.input, force="mesh", process=True) if args.input else humanoid()
    if not isinstance(mesh, trimesh.Trimesh) or not len(mesh.faces):
        raise ValueError("Input does not contain a triangle mesh")
    if not np.isfinite(mesh.vertices).all():
        raise ValueError("Input has non-finite coordinates")
    mesh = exact_faces(mesh, args.target_faces)
    paint(mesh, not args.input, args.flat_shade)
    output = args.output_dir.resolve()
    manifest_path = output / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {"version": 1, "assets": []}
    if not isinstance(manifest, dict) or not isinstance(manifest.get("assets"), list):
        raise ValueError("Existing manifest must contain an assets array")
    glb = mesh.export(file_type="glb", include_normals=True)
    # Validate binary structure before publishing either the model or its metadata.
    parsed = GLTF2.load_from_bytes(glb)
    if not parsed.meshes or not parsed.accessors:
        raise RuntimeError("GLB validation failed")
    obj = trimesh.exchange.obj.export_obj(mesh, include_normals=True, include_color=True)
    atomic_write(output / "models" / f"{slug}.glb", glb)
    atomic_write(output / "models" / f"{slug}.obj", obj.encode())
    record = {"id": slug, "name": name, "filename": f"models/{slug}.glb", "objFilename": f"models/{slug}.obj",
              "vertices": len(mesh.vertices), "faces": len(mesh.faces), "flatShading": args.flat_shade,
              "preset": args.preset if not args.input else "imported", "generatedAt": datetime.now(timezone.utc).isoformat(),
              "bytes": len(glb)}
    manifest["assets"] = [a for a in manifest["assets"] if a.get("id") != slug] + [record]
    atomic_write(manifest_path, (json.dumps(manifest, indent=2) + "\n").encode())
    print(json.dumps(record, indent=2))
    return record


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--input", type=Path, help="Optional source mesh; coordinates are kept (viewer assumes Y-up)")
    cli.add_argument("--name", default="Atlas / T-Pose", help="Display name; safe filenames are derived automatically")
    cli.add_argument("--target-faces", type=int, default=1500)
    cli.add_argument("--flat-shade", action=argparse.BooleanOptionalAction, default=True)
    cli.add_argument("--preset", choices=["stylized-tpose"], default="stylized-tpose")
    cli.add_argument("--output-dir", type=Path, default=ROOT / "public" / "assets")
    return cli


if __name__ == "__main__":
    cli = parser()
    try:
        generate(cli.parse_args())
    except (ValueError, RuntimeError, OSError) as error:
        cli.exit(1, f"Generation failed: {error}\n")
