import * as THREE from 'three';
import { initVideoTracker, detectVideo, detectImage } from './tracker.js';
import { FaceState } from './pose.js';
import { FaceSwap, sampleSkin } from './face-swap.js';
import { AvatarLayer } from './avatar.js';
import { storage } from './storage.js';
import { TRIANGLES } from './face-mesh-data.js';

const $ = (id) => document.getElementById(id);
const video = $('video');
const canvas = $('view');

// ---------- Escena ----------
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(1);
const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -10000, 10000);
camera.position.z = 0;

const videoTex = new THREE.VideoTexture(video);
videoTex.colorSpace = THREE.SRGBColorSpace;
const bg = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ map: videoTex, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
);
bg.position.z = -9000;
bg.renderOrder = -1;
scene.add(bg);

const face = new FaceState();
const faceSwap = new FaceSwap(scene);
const avatar = new AvatarLayer(scene);

// Malla de depuración (aristas de los triángulos)
const debugGeo = new THREE.BufferGeometry();
debugGeo.setAttribute('position', faceSwap.pos);
{
  const edges = [];
  for (let t = 0; t < TRIANGLES.length; t += 3) {
    const a = TRIANGLES[t], b = TRIANGLES[t + 1], c = TRIANGLES[t + 2];
    edges.push(a, b, b, c, c, a);
  }
  debugGeo.setIndex(edges);
}
const debugMesh = new THREE.LineSegments(debugGeo, new THREE.LineBasicMaterial({ color: 0x00ffaa, transparent: true, opacity: 0.5, depthTest: false }));
debugMesh.frustumCulled = false;
debugMesh.renderOrder = 5;
debugMesh.visible = false;
scene.add(debugMesh);

let W = 720, H = 1280;
let facing = 'user';
let mirrored = true;
const prefs = Object.assign({ smoothing: 0.5, showMesh: false, recDot: true, active: 'doll' }, JSON.parse(localStorage.getItem('prefs') || '{}'));
const savePrefs = () => localStorage.setItem('prefs', JSON.stringify(prefs));

function resize(w, h) {
  W = w; H = h;
  renderer.setSize(W, H, false);
  camera.left = -W / 2; camera.right = W / 2; camera.top = H / 2; camera.bottom = -H / 2;
  camera.updateProjectionMatrix();
  bg.scale.set(mirrored ? -W : W, H, 1);
}

// ---------- Cámara ----------
let stream = null;
let micStream = null;
async function startCamera() {
  if (stream) stream.getVideoTracks().forEach((t) => t.stop());
  const videoOpts = { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  if (!micStream) {
    // Se pide cámara y micrófono a la vez para que no salte otro permiso en la pantalla limpia.
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoOpts, audio: { echoCancellation: true, noiseSuppression: true } });
      micStream = new MediaStream(stream.getAudioTracks());
    } catch (err) {
      console.warn('Sin micrófono, solo vídeo', err);
      stream = await navigator.mediaDevices.getUserMedia({ video: videoOpts, audio: false });
    }
  } else {
    stream = await navigator.mediaDevices.getUserMedia({ video: videoOpts, audio: false });
  }
  video.srcObject = new MediaStream(stream.getVideoTracks());
  await video.play();
  mirrored = facing === 'user';
  await new Promise((r) => (video.videoWidth ? r() : video.addEventListener('loadedmetadata', r, { once: true })));
  resize(video.videoWidth, video.videoHeight);
  face.hasPrev = false;
}

// ---------- Filtros ----------
const BUILTIN = [
  { id: 'none', type: 'none', name: 'Normal', icon: '🙂' },
  { id: 'doll', type: 'doll', name: 'Muñeco', icon: '🧸' },
];
let filters = [...BUILTIN];
let active = null;
const runtime = new Map(); // id -> datos ya preparados (canvas, etc.)

const DEFAULTS = {
  face: { opacity: 1, feather: 2.5, colorMatch: 0.7, holes: true },
  avatar: { scale: 1, height: 0, depth: 0, swapLR: false },
};

function filterSettings(f) {
  if (!f.settings) f.settings = {};
  const base = f.type === 'face' ? DEFAULTS.face : DEFAULTS.avatar;
  for (const k in base) if (f.settings[k] === undefined) f.settings[k] = base[k];
  return f.settings;
}

async function blobToCanvas(blob, maxSize = 1024) {
  const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  const s = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

function makeThumb(c, lm) {
  const t = document.createElement('canvas');
  t.width = t.height = 128;
  const ctx = t.getContext('2d');
  let sx = 0, sy = 0, size = Math.min(c.width, c.height);
  if (lm) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of lm) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
    size = Math.max((maxX - minX) * c.width, (maxY - minY) * c.height) * 1.15;
    sx = ((minX + maxX) / 2) * c.width - size / 2;
    sy = ((minY + maxY) / 2) * c.height - size / 2;
  } else {
    sx = (c.width - size) / 2; sy = (c.height - size) / 2;
  }
  ctx.drawImage(c, sx, sy, size, size, 0, 0, 128, 128);
  return t.toDataURL('image/jpeg', 0.8);
}

async function addImageFile(file) {
  toast('Analizando imagen…');
  const c = await blobToCanvas(file);
  const blob = await new Promise((r) => c.toBlob(r, file.type === 'image/png' ? 'image/png' : 'image/jpeg', 0.92));
  const lm = await detectImage(c);
  const item = {
    id: 'f' + Date.now() + Math.random().toString(36).slice(2, 6),
    type: lm ? 'face' : 'sticker',
    name: file.name.replace(/\.[^.]+$/, '').slice(0, 14) || 'Foto',
    blob, landmarks: lm, thumb: makeThumb(c, lm), created: Date.now(),
  };
  runtime.set(item.id, { canvas: c });
  await storage.put(item);
  filters.push(item);
  renderChoices();
  await selectFilter(item.id);
  toast(lm ? '¡Cara detectada! Ya puedes usarla.' : 'No vi una cara en la imagen: la uso como máscara.');
}

async function addModelFile(file) {
  const lower = file.name.toLowerCase();
  if (!lower.endsWith('.glb') && !lower.endsWith('.gltf')) {
    toast('Elige un archivo .glb (recomendado) o .gltf');
    return;
  }
  const item = {
    id: 'f' + Date.now() + Math.random().toString(36).slice(2, 6),
    type: 'model', name: file.name.replace(/\.[^.]+$/, '').slice(0, 14),
    blob: file.slice(0, file.size, 'model/gltf-binary'), created: Date.now(),
  };
  await storage.put(item);
  filters.push(item);
  renderChoices();
  await selectFilter(item.id);
}

async function selectFilter(id) {
  const f = filters.find((x) => x.id === id) || filters[0];
  active = f;
  prefs.active = f.id; savePrefs();
  renderChoices();
  faceSwap.setFilter(null);
  avatar.clear();
  const el = document.querySelector(`.choice[data-id="${f.id}"]`);
  el?.classList.add('busy');
  try {
    if (f.type === 'doll') avatar.setBuiltIn();
    else if (f.type === 'face' || f.type === 'sticker') {
      let rt = runtime.get(f.id);
      if (!rt) { rt = { canvas: await blobToCanvas(f.blob) }; runtime.set(f.id, rt); }
      if (active !== f) return;
      if (f.type === 'face') faceSwap.setFilter({ canvas: rt.canvas, landmarks: f.landmarks });
      else avatar.setSticker(rt.canvas);
    } else if (f.type === 'model') {
      const buf = await f.blob.arrayBuffer();
      if (active !== f) return;
      const info = await avatar.setModel(buf);
      if (info.morphCount) toast('Modelo con gestos faciales: ¡abre la boca y parpadea!');
    }
    applySettings();
    refreshSettings();
  } catch (err) {
    console.error(err);
    toast('No se pudo cargar este filtro: ' + err.message);
  } finally {
    el?.classList.remove('busy');
  }
}

function applySettings() {
  if (!active || active.type === 'none') return;
  const s = filterSettings(active);
  if (active.type === 'face') {
    faceSwap.setOpacity(s.opacity);
    faceSwap.setFeather(s.feather);
    faceSwap.setColorMatch(s.colorMatch);
    if (faceSwap.settings.holes !== s.holes) faceSwap.setHoles(s.holes);
  } else {
    Object.assign(avatar.settings, { scale: s.scale, height: s.height, depth: s.depth, swapLR: s.swapLR });
  }
}

function renderChoices() {
  const box = $('choices');
  box.innerHTML = '';
  const card = (cls, thumbText, nameText, onclick) => {
    const el = document.createElement('div');
    el.className = 'choice ' + cls;
    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.textContent = thumbText;
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = nameText;
    el.append(thumb, name);
    el.onclick = onclick;
    box.appendChild(el);
    return el;
  };
  for (const f of filters) {
    const el = card(active?.id === f.id ? 'active' : '', f.thumb ? '' : f.icon || (f.type === 'model' ? '🧊' : '🙂'), f.name, () => selectFilter(f.id));
    el.dataset.id = f.id;
    if (f.thumb) el.firstChild.style.backgroundImage = `url(${f.thumb})`;
  }
  card('add', '＋📷', 'Foto de cara', () => $('imageInput').click());
  card('add', '＋🧊', 'Modelo 3D', () => $('modelInput').click());
}

// ---------- Ajustes ----------
function refreshSettings() {
  const f = active;
  const isFace = f?.type === 'face';
  const isAvatar = !!f && ['doll', 'model', 'sticker'].includes(f.type);
  $('faceSettings').classList.toggle('hidden', !isFace);
  $('avatarSettings').classList.toggle('hidden', !isAvatar);
  $('btnDelete').classList.toggle('hidden', !f || f.type === 'none' || f.type === 'doll');
  $('settingsTitle').textContent = f && f.type !== 'none' ? `Ajustes: ${f.name}` : 'Ajustes';
  if (isFace || isAvatar) {
    const s = filterSettings(f);
    $('sOpacity').value = s.opacity; $('sFeather').value = s.feather; $('sColor').value = s.colorMatch; $('sHoles').checked = s.holes;
    $('sScale').value = s.scale; $('sHeight').value = s.height; $('sDepth').value = s.depth; $('sSwap').checked = s.swapLR;
  }
  $('sSmooth').value = prefs.smoothing;
  $('sMesh').checked = prefs.showMesh;
  $('sDot').checked = prefs.recDot;
}

let saveTimer = null;
function persistActive() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (active && !BUILTIN.includes(active)) storage.put(active);
    else if (active?.type === 'doll') { prefs.dollSettings = active.settings; savePrefs(); }
  }, 400);
}
const bind = (id, key, isCheck = false) => {
  $(id).addEventListener('input', () => {
    if (!active || active.type === 'none') return;
    filterSettings(active)[key] = isCheck ? $(id).checked : parseFloat($(id).value);
    applySettings();
    persistActive();
  });
};
bind('sOpacity', 'opacity'); bind('sFeather', 'feather'); bind('sColor', 'colorMatch'); bind('sHoles', 'holes', true);
bind('sScale', 'scale'); bind('sHeight', 'height'); bind('sDepth', 'depth'); bind('sSwap', 'swapLR', true);
$('sSmooth').addEventListener('input', () => { prefs.smoothing = parseFloat($('sSmooth').value); savePrefs(); });
$('sMesh').addEventListener('change', () => { prefs.showMesh = $('sMesh').checked; savePrefs(); });
$('sDot').addEventListener('change', () => { prefs.recDot = $('sDot').checked; savePrefs(); });
$('btnDelete').onclick = async () => {
  if (!active || BUILTIN.includes(active)) return;
  if (!confirm(`¿Borrar "${active.name}"?`)) return;
  await storage.remove(active.id);
  runtime.delete(active.id);
  filters = filters.filter((f) => f !== active);
  await selectFilter('none');
};

$('imageInput').onchange = async (e) => {
  for (const file of e.target.files) {
    try { await addImageFile(file); } catch (err) { console.error(err); toast('Error con la imagen: ' + err.message); }
  }
  e.target.value = '';
};
$('modelInput').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) try { await addModelFile(file); } catch (err) { console.error(err); toast('Error con el modelo: ' + err.message); }
};

$('btnFlip').onclick = async () => {
  facing = facing === 'user' ? 'environment' : 'user';
  try { await startCamera(); } catch (err) { toast('No se pudo cambiar de cámara'); facing = 'user'; await startCamera(); }
};

// ---------- Modos: configuración / pantalla limpia ----------
const app = $('app');
const stage = $('stage');
let mode = 'start';
let wakeLock = null;
let cleanSince = 0;

function setMode(m) {
  mode = m;
  app.className = 'mode-' + m;
  if (m === 'setup') $('previewBox').prepend(canvas);
  else if (m === 'clean') stage.append(canvas);
}

async function enterClean() {
  setMode('clean');
  cleanSince = performance.now();
  history.pushState({ clean: true }, '');
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); } catch {}
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}

function exitClean(fromHistory = false) {
  if (mode !== 'clean') return;
  if (recorder) stopRecording();
  setMode('setup');
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (!fromHistory && history.state?.clean) history.back();
}

$('btnGo').onclick = enterClean;
window.addEventListener('popstate', () => exitClean(true));
// El botón atrás de Android sale primero de pantalla completa: lo tratamos como "volver".
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && mode === 'clean' && performance.now() - cleanSince > 1000
      && $('preview').classList.contains('hidden')) exitClean();
});

// Gestos ocultos en la pantalla limpia: mantener pulsado = grabar/parar, doble toque = volver.
let pressTimer = null, lastTap = 0;
stage.addEventListener('pointerdown', (e) => {
  if (mode !== 'clean') return;
  e.preventDefault();
  clearTimeout(pressTimer);
  pressTimer = setTimeout(() => { pressTimer = null; toggleRecording(); }, 600);
});
stage.addEventListener('pointerup', () => {
  if (mode !== 'clean' || !pressTimer) return;
  clearTimeout(pressTimer); pressTimer = null;
  const now = performance.now();
  if (now - lastTap < 350) { lastTap = 0; exitClean(); } else lastTap = now;
});
stage.addEventListener('pointercancel', () => { clearTimeout(pressTimer); pressTimer = null; });
stage.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- Grabación ----------
const MAX_SECONDS = 300;
let recorder = null, recChunks = [], recTimer = null;
let lastCapture = null;

function pickMime() {
  const types = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
}

function toggleRecording() {
  if (recorder) { stopRecording(); navigator.vibrate?.([30, 50, 30]); }
  else { startRecording(); navigator.vibrate?.(50); }
}

function startRecording() {
  if (!window.MediaRecorder) { toast('Este navegador no permite grabar'); return; }
  const out = canvas.captureStream(30);
  micStream?.getAudioTracks().forEach((t) => out.addTrack(t));
  const mimeType = pickMime();
  recorder = new MediaRecorder(out, { mimeType, videoBitsPerSecond: 6_000_000 });
  recChunks = [];
  recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
  const rec = recorder;
  rec.onstop = () => {
    const blob = new Blob(recChunks, { type: rec.mimeType || mimeType || 'video/webm' });
    showPreview(blob);
  };
  rec.start(500);
  $('recDot').classList.toggle('hidden', !prefs.recDot);
  recTimer = setTimeout(stopRecording, MAX_SECONDS * 1000);
}

function stopRecording() {
  if (!recorder) return;
  const rec = recorder;
  recorder = null;
  clearTimeout(recTimer);
  $('recDot').classList.add('hidden');
  if (rec.state !== 'inactive') rec.stop();
}

function showPreview(blob) {
  const url = URL.createObjectURL(blob);
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  lastCapture = { blob, url, name: `filtro-${stamp}.${ext}` };
  const media = $('previewMedia');
  media.innerHTML = '';
  const el = document.createElement('video');
  el.src = url; el.controls = true; el.loop = true; el.autoplay = true; el.playsInline = true;
  media.appendChild(el);
  $('preview').classList.remove('hidden');
}
$('btnDiscard').onclick = () => {
  $('preview').classList.add('hidden');
  if (lastCapture) URL.revokeObjectURL(lastCapture.url);
  $('previewMedia').innerHTML = '';
  lastCapture = null;
};
$('btnSave').onclick = () => {
  if (!lastCapture) return;
  const a = document.createElement('a');
  a.href = lastCapture.url; a.download = lastCapture.name;
  document.body.appendChild(a); a.click(); a.remove();
  toast('Guardado en Descargas');
};
$('btnShare').onclick = async () => {
  if (!lastCapture) return;
  const file = new File([lastCapture.blob], lastCapture.name, { type: lastCapture.blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Filtro Caras' }); } catch {}
  } else {
    $('btnSave').click();
  }
};

// ---------- Bucle principal ----------
let lastVideoTime = -1, frameCount = 0, lastNow = performance.now();
function loop(now) {
  requestAnimationFrame(loop);
  const dt = Math.min(0.1, (now - lastNow) / 1000);
  lastNow = now;
  if (video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    let det = null;
    try { det = detectVideo(video, now); } catch (err) { console.warn(err); }
    face.update(det, W, H, mirrored, prefs.smoothing);
    if (det && active?.type === 'face' && frameCount++ % 8 === 0) {
      faceSwap.updateColor(sampleSkin(video, det.landmarks));
    }
    setHint(face.visible ? '' : 'Pon tu cara frente a la cámara');
  }
  if (face.visible) { faceSwap.pos.array.set(face.world); faceSwap.pos.needsUpdate = true; }
  faceSwap.update(face, active?.type === 'face');
  avatar.update(face, ['doll', 'model', 'sticker'].includes(active?.type), dt);
  debugMesh.visible = prefs.showMesh && face.visible;
  renderer.render(scene, camera);
}

let hintText = null;
function setHint(t) { if (t !== hintText) { hintText = t; $('hint').textContent = t; } }

let toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3500);
}

// ---------- Inicio ----------
async function start() {
  const status = $('status');
  $('btnStart').disabled = true;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite usar la cámara (¿falta HTTPS?)');
    status.textContent = 'Abriendo cámara…';
    await startCamera();
    status.textContent = 'Cargando detector de caras…';
    await initVideoTracker();
    setMode('setup');
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    status.textContent = 'Error: ' + (err.message || err.name || err);
    $('btnStart').disabled = false;
  }
}
$('btnStart').onclick = start;

(async () => {
  try {
    const saved = await storage.all();
    filters = [...BUILTIN, ...saved];
  } catch (err) { console.warn('IndexedDB no disponible', err); }
  BUILTIN[1].settings = prefs.dollSettings;
  renderChoices();
  await selectFilter(prefs.active);
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW', e));
}

// Exponer para pruebas
window.__app = { face, faceSwap, avatar, get active() { return active; }, get mode() { return mode; }, get recording() { return !!recorder; }, selectFilter };
