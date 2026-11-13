// Service worker: guarda la app en caché para que funcione sin conexión.
const VERSION = 'filtro-caras-v3';
const BIG = 'filtro-caras-modelos-v1';
const ASSETS = [
  './', 'index.html', 'styles.css', 'manifest.webmanifest',
  'js/app.js', 'js/tracker.js', 'js/pose.js', 'js/face-swap.js', 'js/avatar.js', 'js/storage.js', 'js/face-mesh-data.js', 'js/ai-swap.js',
  'vendor/three/three.module.js', 'vendor/three/three.core.js',
  'vendor/three/addons/loaders/GLTFLoader.js', 'vendor/three/addons/utils/BufferGeometryUtils.js', 'vendor/three/addons/utils/SkeletonUtils.js',
  'vendor/mediapipe/vision_bundle.mjs', 'vendor/mediapipe/wasm/vision_wasm_internal.js', 'vendor/mediapipe/wasm/vision_wasm_internal.wasm',
  'models/face_landmarker.task', 'icons/icon-192.png', 'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== BIG).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  if (new URL(e.request.url).origin !== location.origin) return;
  // Primero la caché; lo que se descarga (p. ej. los modelos de IA) se guarda para la próxima vez.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok && res.status === 200) {
        const copy = res.clone();
        // Los modelos grandes van a una caché aparte que no se borra al actualizar la app.
        const big = /\/models\/|\/vendor\//.test(e.request.url);
        caches.open(big ? BIG : VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    })),
  );
});
