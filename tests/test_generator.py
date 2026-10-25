"""Integration checks, using only stdlib unittest and project dependencies."""
import argparse
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from pygltflib import GLTF2
import trimesh

from scripts.generate_asset import exact_faces, generate, humanoid, paint, parser


class GeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = humanoid()

    def test_welded_closed_connected_base(self):
        self.assertTrue(self.base.is_watertight)
        self.assertTrue(self.base.is_winding_consistent)
        self.assertEqual(len(self.base.split()), 1)
        self.assertEqual(self.base.euler_number, 2)
        self.assertGreater(self.base.volume, 0)
        # Polygonization/smoothing on a sampled lattice is approximately symmetric.
        from scipy.spatial import cKDTree
        mirrored = self.base.vertices.copy()
        mirrored[:, 0] *= -1
        distances, _ = cKDTree(self.base.vertices).query(mirrored)
        self.assertLess(distances.max(), 0.04)

    def test_exact_budgets_and_topology(self):
        for target in (100, 800, 1500, 3000):
            with self.subTest(target=target):
                result = exact_faces(self.base.copy(), target)
                self.assertEqual(len(result.faces), target)
                self.assertTrue(result.is_watertight)
                self.assertTrue(result.is_winding_consistent)
                self.assertTrue(np.isfinite(result.vertices).all())

    def test_flat_normals_and_colors(self):
        mesh = exact_faces(self.base.copy(), 800)
        paint(mesh, procedural=True, flat=True)
        self.assertEqual(len(mesh.vertices), 2400)
        expected = np.repeat(mesh.face_normals, 3, axis=0)
        np.testing.assert_allclose(mesh.vertex_normals, expected, atol=1e-6)
        self.assertGreater(len(np.unique(mesh.visual.vertex_colors, axis=0)), 2)

    def test_refinement_preserves_surface(self):
        mesh = trimesh.creation.icosphere(subdivisions=1)
        result = exact_faces(mesh, 1500)
        self.assertEqual(len(result.faces), 1500)
        self.assertTrue(result.is_watertight)
        self.assertAlmostEqual(mesh.volume, result.volume, places=8)

    def test_bad_targets(self):
        for count in (0, -2, 801, 100002):
            with self.assertRaises(ValueError):
                exact_faces(self.base.copy(), count)


class ExportTests(unittest.TestCase):
    def test_exports_and_manifest_upsert(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            args = argparse.Namespace(input=None, name='Test / Asset', target_faces=800,
                                      flat_shade=True, preset='stylized-tpose', output_dir=output)
            with contextlib.redirect_stdout(io.StringIO()):
                record = generate(args)
                args.flat_shade = False
                generate(args)
                args.name = 'Second Asset'
                generate(args)
            manifest = json.loads((output / 'manifest.json').read_text())
            self.assertEqual(len(manifest['assets']), 2)
            self.assertFalse(manifest['assets'][0]['flatShading'])
            self.assertEqual(record['faces'], 800)
            self.assertIn('+00:00', record['generatedAt'])
            gltf = GLTF2().load(str(output / 'models/test-asset.glb'))
            primitive = gltf.meshes[0].primitives[0]
            self.assertIsNotNone(primitive.attributes.NORMAL)
            self.assertIsNotNone(primitive.attributes.COLOR_0)
            self.assertEqual(gltf.accessors[primitive.indices].count, 2400)
            self.assertEqual(len(trimesh.load(output / 'models/test-asset.obj', force='mesh').faces), 800)
            self.assertEqual(len(trimesh.load(output / 'models/test-asset.glb', force='mesh').faces), 800)

    def test_import_and_safe_names(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            source = output / 'source.obj'
            trimesh.creation.icosphere(subdivisions=2).export(source)
            args = parser().parse_args(['--input', str(source), '--name', '../../Imported Asset',
                                       '--target-faces', '800', '--output-dir', str(output), '--no-flat-shade'])
            with contextlib.redirect_stdout(io.StringIO()):
                record = generate(args)
            self.assertEqual(record['id'], 'imported-asset')
            self.assertEqual(record['preset'], 'imported')
            self.assertTrue((output / record['filename']).exists())

    def test_bad_name(self):
        args = parser().parse_args(['--name', '///'])
        with self.assertRaises(ValueError):
            generate(args)


if __name__ == '__main__':
    unittest.main()
