import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const number = new Intl.NumberFormat('en-US');
const scene = new THREE.Scene();
scene.background = new THREE.Color('#20262e');
const camera = new THREE.PerspectiveCamera(36, 1, 0.01, 1000);
let renderer, controls, current, selected, sequence = 0, assets = [], meshes = [], frameBounds;
const loader = new GLTFLoader();
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
const loading = $('loading');
const mount = $('canvas-mount');
const downloads = [$('download-glb'), $('download-obj')];

function notice(message) {
  $('notice').textContent = message;
  $('notice').hidden = false;
}
function status(message) { $('viewer-status').textContent = message; }
function assetURL(filename) {
  // Keep manifest references inside assets/, including on project Pages sites.
  if (typeof filename !== 'string' || !/^models\/[a-z0-9-]+\.(glb|obj)$/.test(filename)) {
    throw new Error('The manifest contains an invalid asset path.');
  }
  return new URL(`assets/${filename}`, document.baseURI).href;
}
function disposeModel(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root.traverse((node) => {
    if (!node.isMesh) return;
    geometries.add(node.geometry);
    if (node.userData.originalGeometry) geometries.add(node.userData.originalGeometry);
    if (node.userData.smoothGeometry) geometries.add(node.userData.smoothGeometry);
    for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
      materials.add(material);
      Object.values(material).forEach((value) => { if (value?.isTexture) textures.add(value); });
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

function initRenderer() {
  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.25;
  renderer.domElement.setAttribute('aria-label', '3D asset. Drag to orbit, scroll to zoom, right-drag to pan.');
  renderer.domElement.setAttribute('role', 'img');
  mount.append(renderer.domElement);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;
  controls.autoRotateSpeed = 1.2;
  controls.maxPolarAngle = Math.PI * 0.51;
  scene.add(new THREE.HemisphereLight(0xd5e7fa, 0x5a5b53, 2.3));
  const key = new THREE.DirectionalLight(0xffefd9, 4.2);
  key.position.set(3, 6, 4);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -5; key.shadow.camera.right = 5;
  key.shadow.camera.top = 5; key.shadow.camera.bottom = -5;
  key.shadow.normalBias = 0.025;
  key.shadow.bias = -0.0001;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xc4d6ff, 2.5);
  rim.position.set(-3, 3, -4); scene.add(rim);
  const fill = new THREE.DirectionalLight(0xffffff, 0.7);
  fill.position.set(-4, 2, 3); scene.add(fill);
  const grid = new THREE.GridHelper(30, 60, 0x65717f, 0x414c58);
  grid.material.transparent = true; grid.material.opacity = 0.35;
  scene.add(grid);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200), new THREE.ShadowMaterial({ opacity: 0.2 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.008; ground.receiveShadow = true;
  scene.add(ground);
  const resize = () => {
    const { width, height } = mount.getBoundingClientRect();
    if (!width || !height) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    if (frameBounds) fitCamera();
  };
  new ResizeObserver(resize).observe(mount);
  resize();
  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const delta = Math.min(clock.getDelta(), 0.1);
    controls.update(delta);
    renderer.render(scene, camera);
  });
  renderer.domElement.addEventListener('webglcontextlost', (event) => {
    event.preventDefault(); status('CONTEXT LOST');
    notice('The graphics context was lost. Reload the page to restore the viewer.');
  });
}

function fitCamera() {
  if (!frameBounds || !controls) return;
  const size = frameBounds.getSize(new THREE.Vector3());
  const center = frameBounds.getCenter(new THREE.Vector3());
  const vertical = THREE.MathUtils.degToRad(camera.fov);
  const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * camera.aspect);
  const distance = Math.max(size.y / (2 * Math.tan(vertical / 2)), size.x / (2 * Math.tan(horizontal / 2))) * 1.25 + size.z;
  controls.target.copy(center);
  camera.position.copy(center).add(new THREE.Vector3(0.25, 0.13, 1).normalize().multiplyScalar(distance));
  camera.near = Math.max(distance / 1000, 0.001); camera.far = Math.max(distance * 100, 100);
  controls.minDistance = Math.max(size.length() * 0.2, 0.01);
  controls.maxDistance = Math.max(size.length() * 8, 5);
  camera.updateProjectionMatrix(); controls.update();
}

function smoothGeometry(original) {
  // GLB flat exports have unshared vertices. Average area-weighted normals by
  // position, not by index, so the smooth toggle genuinely smooths these seams.
  const geometry = original.clone();
  const positions = geometry.attributes.position;
  const sums = new Map();
  const keys = Array.from({ length: positions.count }, (_, i) =>
    [positions.getX(i), positions.getY(i), positions.getZ(i)].map((n) => Math.round(n * 1e6)).join(','));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const ab = new THREE.Vector3(), ac = new THREE.Vector3();
  const total = geometry.index?.count ?? positions.count;
  for (let i = 0; i < total; i += 3) {
    const indices = [0, 1, 2].map((n) => geometry.index ? geometry.index.getX(i + n) : i + n);
    a.fromBufferAttribute(positions, indices[0]); b.fromBufferAttribute(positions, indices[1]); c.fromBufferAttribute(positions, indices[2]);
    const normal = ab.subVectors(b, a).cross(ac.subVectors(c, a));
    indices.forEach((index) => {
      if (!sums.has(keys[index])) sums.set(keys[index], new THREE.Vector3());
      sums.get(keys[index]).add(normal);
    });
  }
  const normals = new Float32Array(positions.count * 3);
  keys.forEach((key, i) => sums.get(key).clone().normalize().toArray(normals, i * 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return geometry;
}

function applyShading() {
  const flat = $('flat-shading').checked;
  meshes.forEach((mesh) => {
    if (!flat && !mesh.userData.smoothGeometry) mesh.userData.smoothGeometry = smoothGeometry(mesh.userData.originalGeometry);
    mesh.geometry = flat ? mesh.userData.originalGeometry : mesh.userData.smoothGeometry;
    mesh.material.flatShading = flat;
    mesh.material.needsUpdate = true;
    mesh.userData.wire.geometry = mesh.geometry;
  });
}
function applyTint() {
  const color = $('material-color').value;
  meshes.forEach((mesh) => mesh.material.color.copy(mesh.userData.baseColor).multiply(new THREE.Color(color)));
  $('material-value').textContent = color === '#ffffff' ? 'Original colors' : color.toUpperCase();
}

async function selectAsset(asset) {
  const token = ++sequence;
  selected = asset;
  renderGallery();
  $('notice').hidden = true;
  if (renderer) {
    loading.hidden = false; loading.textContent = 'Loading geometry…'; status('LOADING');
  }
  downloads.forEach((link) => { link.classList.add('disabled'); link.setAttribute('aria-disabled', 'true'); link.removeAttribute('href'); });
  $('model-title').textContent = asset.name;
  $('model-subtitle').textContent = 'Procedural geometry. Deliberately faceted.';
  try {
    const glbURL = assetURL(asset.filename), objURL = assetURL(asset.objFilename);
    // Downloads remain available even when WebGL isn't supported.
    if (!renderer) {
      downloads.forEach((link, i) => { link.href = i === 0 ? glbURL : objURL; link.classList.remove('disabled'); link.removeAttribute('aria-disabled'); });
      return;
    }
    const gltf = await loader.loadAsync(glbURL);
    if (token !== sequence) { disposeModel(gltf.scene); return; }
    const next = gltf.scene;
    const nextMeshes = [];
    let vertices = 0, faces = 0;
    // Collect before adding wire meshes, so traversal never recursively processes overlays.
    next.traverse((node) => { if (node.isMesh) nextMeshes.push(node); });
    if (!nextMeshes.length) throw new Error('This GLB does not contain a mesh.');
    nextMeshes.forEach((mesh) => {
      const position = mesh.geometry.attributes.position;
      vertices += position.count; faces += (mesh.geometry.index?.count ?? position.count) / 3;
      const old = mesh.material;
      mesh.material = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: Boolean(mesh.geometry.attributes.color),
        roughness: 0.82, metalness: 0.02, flatShading: true,
      });
      for (const material of Array.isArray(old) ? old : [old]) {
        Object.values(material).forEach((value) => { if (value?.isTexture) value.dispose(); });
        material.dispose();
      }
      mesh.castShadow = true; mesh.receiveShadow = true;
      mesh.userData.originalGeometry = mesh.geometry;
      mesh.userData.baseColor = mesh.material.color.clone();
      const wire = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({
        color: 0xd4fa77, wireframe: true, transparent: true, opacity: 0.4,
        depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      }));
      wire.visible = $('wireframe').checked;
      mesh.userData.wire = wire; mesh.add(wire);
    });
    if (current) { scene.remove(current); disposeModel(current); }
    current = next; meshes = nextMeshes;
    const box = new THREE.Box3().setFromObject(current);
    if (box.isEmpty() || !Number.isFinite(box.min.x)) throw new Error('Model bounds are invalid.');
    // Normalize imported models to roughly human scale, and center at ground level.
    const size = box.getSize(new THREE.Vector3());
    const scale = 2.55 / Math.max(size.x, size.y, size.z, 0.0001);
    current.scale.multiplyScalar(scale);
    box.setFromObject(current);
    const center = box.getCenter(new THREE.Vector3());
    current.position.sub(new THREE.Vector3(center.x, box.min.y, center.z));
    scene.add(current); frameBounds = new THREE.Box3().setFromObject(current);
    $('vertices').textContent = number.format(vertices); $('faces').textContent = number.format(faces);
    $('flat-shading').checked = asset.flatShading !== false;
    $('detail-preset').textContent = asset.preset === 'imported' ? 'Imported mesh' : 'Stylized T-pose';
    $('asset-type').textContent = asset.preset === 'imported' ? 'IMPORTED MESH' : 'STYLIZED HUMANOID';
    $('detail-budget').textContent = `${number.format(faces)} triangles`;
    $('detail-size').textContent = Number.isFinite(asset.bytes) ? `${(asset.bytes / 1024).toFixed(1)} KB` : '—';
    const date = new Date(asset.generatedAt);
    $('detail-date').textContent = Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
    downloads.forEach((link, i) => { link.href = i === 0 ? glbURL : objURL; link.classList.remove('disabled'); link.removeAttribute('aria-disabled'); });
    applyShading(); applyTint(); fitCamera();
    loading.hidden = true; status('ASSET READY');
    history.replaceState(null, '', `#${encodeURIComponent(asset.id)}`);
  } catch (error) {
    if (token !== sequence) return;
    console.error(error); status('LOAD ERROR');
    loading.hidden = false;
    loading.textContent = `Couldn't load this asset. ${error.message} Select another asset or reload to retry.`;
    notice(`Asset loading failed: ${error.message}`);
  }
}

function thumbnail() {
  // Lightweight procedural silhouette, not a baked screenshot or external image.
  return `<svg viewBox="0 0 120 120" aria-hidden="true"><ellipse cx="60" cy="112" rx="26" ry="3" fill="#101820" opacity=".35"/><path fill="#c99a7b" d="m51 8 9-4 10 5 2 13-7 9-10-2-6-9Z"/><path fill="#b18269" d="m60 5 10 4 2 13-7 9-5-13Z"/><path fill="#b98d70" d="M55 27h10v12H55z"/><path fill="#4b6071" d="m47 35 13-4 14 4 6 27-8 10H48L40 60Z"/><path fill="#344757" d="m60 31 14 4 6 27-8 10H60Z"/><path fill="#c99a7b" d="m43 37-8 1-18 2-13 2-1 7 17 1 22-1 6-5Zm33 0 9 1 18 2 13 2 1 7-17 1-22-1-6-5Z"/><path fill="#435969" d="m42 36-10 3 1 11 12-1 5-11Zm35 0 11 3-1 11-12-1-5-11Z"/><path fill="#263643" d="m48 66 24 1 3 20-13 2-2-11-3 11-14-2Z"/><path fill="#c99a7b" d="m45 87 11 1-1 15-8 1Zm18 1 10-1-1 17-8-1Z"/><path fill="#455666" d="m46 101 10 1 1 8-15 1 1-6Zm18 1 9-1 5 8-15 1Z"/><path fill="#ffffff" opacity=".12" d="m47 35 13-4-5 22-13 7Zm3-23 10-8v14Z"/></svg>`;
}
function renderGallery() {
  const query = $('search').value.trim().toLowerCase();
  const filtered = assets.filter((asset) => asset.name.toLowerCase().includes(query));
  $('gallery').replaceChildren();
  $('list-count').textContent = String(filtered.length).padStart(2, '0');
  if (!filtered.length) {
    const empty = document.createElement('p'); empty.className = 'no-results';
    empty.textContent = assets.length ? 'No assets match your search.' : 'No assets yet. Generate your first below.';
    $('gallery').append(empty); return;
  }
  filtered.forEach((asset) => {
    const active = selected?.id === asset.id;
    const card = document.createElement('button');
    card.type = 'button'; card.className = `asset-card${active ? ' active' : ''}`;
    card.setAttribute('aria-pressed', String(active));
    card.innerHTML = `<div class="asset-preview"><span class="card-label">${asset.flatShading === false ? 'SMOOTH' : 'MID-POLY'}</span>${thumbnail()}${active ? '<span class="card-selected">✓</span>' : ''}</div><div class="asset-info"><strong></strong><div class="asset-meta"><span></span><span class="badge">GLB</span></div></div>`;
    card.querySelector('strong').textContent = asset.name;
    card.querySelector('.asset-meta>span').textContent = `${number.format(asset.faces)} triangles`;
    card.addEventListener('click', () => selectAsset(asset));
    $('gallery').append(card);
  });
}
function setBackground(value) {
  scene.background.set(value); $('background').value = value;
  $('background-value').textContent = value.toUpperCase();
  $('viewport').style.background = value;
  document.querySelectorAll('.swatch').forEach((button) => {
    const active = button.dataset.color === value;
    button.classList.toggle('selected', active); button.setAttribute('aria-pressed', String(active));
  });
}

$('wireframe').addEventListener('change', (event) => meshes.forEach((mesh) => { mesh.userData.wire.visible = event.target.checked; }));
$('flat-shading').addEventListener('change', applyShading);
$('auto-rotate').addEventListener('change', (event) => { if (controls) controls.autoRotate = event.target.checked; });
$('background').addEventListener('input', (event) => setBackground(event.target.value));
$('background-swatches').addEventListener('click', (event) => { const button = event.target.closest('[data-color]'); if (button) setBackground(button.dataset.color); });
$('material-color').addEventListener('input', applyTint);
$('reset-color').addEventListener('click', () => { $('material-color').value = '#ffffff'; applyTint(); });
$('reset-camera').addEventListener('click', fitCamera);
$('search').addEventListener('input', renderGallery);
document.addEventListener('keydown', (event) => {
  if (['INPUT', 'TEXTAREA'].includes(event.target.tagName)) return;
  if (event.key === '/') { event.preventDefault(); $('search').focus(); }
  if (event.key.toLowerCase() === 'f') fitCamera();
});

async function boot() {
  try {
    const configResponse = await fetch('config.json', { cache: 'no-cache' });
    if (configResponse.ok) {
      const config = await configResponse.json();
      if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(config.repository)) {
        const repo = `https://github.com/${config.repository}`;
        $('repo-link').href = repo; $('generate-link').href = `${repo}/actions/workflows/deploy.yml`;
      }
    }
  } catch { /* Repository links use a working checked-in default offline. */ }
  try { initRenderer(); }
  catch (error) {
    console.error(error); renderer = null; status('WEBGL UNAVAILABLE');
    loading.textContent = 'WebGL could not start. Enable hardware acceleration or try another browser. You can still download assets.';
  }
  // Rotation is opt-in, particularly for users requesting reduced motion.
  if (reducedMotion) $('auto-rotate').checked = false;
  try {
    const response = await fetch('assets/manifest.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Manifest returned HTTP ${response.status}`);
    const manifest = await response.json();
    if (!Array.isArray(manifest.assets)) throw new Error('Invalid manifest: assets must be an array');
    assets = manifest.assets.filter((asset) => typeof asset.name === 'string' && typeof asset.id === 'string' && Number.isFinite(asset.faces));
    $('asset-count').textContent = assets.length;
    renderGallery();
    if (!assets.length) { status('LIBRARY EMPTY'); loading.textContent = 'Your workshop is ready. Generate an asset to get started.'; return; }
    let hash = ''; try { hash = decodeURIComponent(location.hash.slice(1)); } catch { /* Ignore malformed URL fragments. */ }
    await selectAsset(assets.find((asset) => asset.id === hash) ?? assets[0]);
  } catch (error) {
    status('LIBRARY ERROR'); loading.hidden = false;
    loading.textContent = 'Unable to load the asset library. Serve public/ over HTTP and check assets/manifest.json.';
    notice(error.message); console.error(error);
  }
}
boot();
