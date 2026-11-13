// Máscara de cara: pega la cara de una foto de referencia sobre la malla facial en vivo.
import * as THREE from 'three';
import { TRIANGLES } from './face-mesh-data.js';
import { CONNECTIONS } from './tracker.js';

const N = 468;

function idsFromConnections(conns) {
  const s = new Set();
  for (const c of conns) { s.add(c.start); s.add(c.end); }
  return s;
}

// Contorno interior de los labios (apertura de la boca).
const INNER_LIPS = new Set([78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95]);

// Distancia (en "anillos" de la malla) de cada vértice al borde de la cara.
function ringDistances() {
  const adj = Array.from({ length: N }, () => new Set());
  for (let t = 0; t < TRIANGLES.length; t += 3) {
    const a = TRIANGLES[t], b = TRIANGLES[t + 1], c = TRIANGLES[t + 2];
    adj[a].add(b); adj[a].add(c); adj[b].add(a); adj[b].add(c); adj[c].add(a); adj[c].add(b);
  }
  const dist = new Array(N).fill(Infinity);
  const queue = [];
  for (const i of idsFromConnections(CONNECTIONS.oval)) { dist[i] = 0; queue.push(i); }
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q];
    for (const j of adj[i]) if (dist[j] === Infinity) { dist[j] = dist[i] + 1; queue.push(j); }
  }
  return dist;
}

function buildIndex(holes) {
  if (!holes) return Array.from(TRIANGLES);
  const left = idsFromConnections(CONNECTIONS.leftEye);
  const right = idsFromConnections(CONNECTIONS.rightEye);
  const sets = [left, right, INNER_LIPS];
  const out = [];
  for (let t = 0; t < TRIANGLES.length; t += 3) {
    const a = TRIANGLES[t], b = TRIANGLES[t + 1], c = TRIANGLES[t + 2];
    const inHole = sets.some((s) => s.has(a) && s.has(b) && s.has(c));
    if (!inHole) out.push(a, b, c);
  }
  return out;
}

const vertexShader = /* glsl */ `
  attribute float aAlpha;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vUv = uv;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const fragmentShader = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 gain;
  uniform float opacity;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vec4 c = texture2D(map, vUv);
    gl_FragColor = vec4(clamp(c.rgb * gain, 0.0, 1.0), c.a * vAlpha * opacity);
  }
`;

export class FaceSwap {
  constructor(scene) {
    this.dist = ringDistances();
    const geo = new THREE.BufferGeometry();
    this.pos = new THREE.BufferAttribute(new Float32Array(N * 3), 3);
    this.pos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.pos);
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(N * 2), 2));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(N), 1));
    this.geometry = geo;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: null },
        gain: { value: new THREE.Vector3(1, 1, 1) },
        opacity: { value: 1 },
      },
      vertexShader,
      fragmentShader,
      transparent: true,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.refColor = null; // color medio de la piel en la foto de referencia
    this.liveGain = new THREE.Vector3(1, 1, 1);
    this.settings = { holes: true, feather: 2.5, opacity: 1, colorMatch: 0.7 };
    this.setHoles(true);
    this.setFeather(2.5);
  }

  /** filter: { canvas (imagen reducida), landmarks (normalizados) } */
  setFilter(filter) {
    if (this.texture) this.texture.dispose();
    if (!filter) { this.texture = null; this.material.uniforms.map.value = null; return; }
    const tex = new THREE.CanvasTexture(filter.canvas);
    tex.flipY = true;
    tex.minFilter = THREE.LinearFilter;
    tex.generateMipmaps = false;
    this.texture = tex;
    this.material.uniforms.map.value = tex;
    const uv = this.geometry.attributes.uv;
    for (let i = 0; i < N; i++) {
      uv.setXY(i, filter.landmarks[i].x, 1 - filter.landmarks[i].y);
    }
    uv.needsUpdate = true;
    this.refColor = sampleSkin(filter.canvas, filter.landmarks);
  }

  setHoles(on) {
    this.settings.holes = on;
    this.geometry.setIndex(buildIndex(on));
  }

  setFeather(rings) {
    this.settings.feather = rings;
    const a = this.geometry.attributes.aAlpha;
    for (let i = 0; i < N; i++) {
      const d = this.dist[i];
      const t = rings <= 0 ? 1 : Math.min(1, d / rings);
      a.setX(i, t * t * (3 - 2 * t)); // smoothstep
    }
    a.needsUpdate = true;
  }

  setOpacity(v) { this.settings.opacity = v; this.material.uniforms.opacity.value = v; }
  setColorMatch(v) { this.settings.colorMatch = v; }

  /** Ajusta el tono de la máscara al de la piel en vivo. */
  updateColor(liveColor) {
    if (!this.refColor || !liveColor) return;
    const s = this.settings.colorMatch;
    const target = new THREE.Vector3(
      clampGain(liveColor[0] / this.refColor[0]),
      clampGain(liveColor[1] / this.refColor[1]),
      clampGain(liveColor[2] / this.refColor[2]),
    );
    target.multiplyScalar(s).addScalar(1 - s);
    this.liveGain.lerp(target, 0.3);
    this.material.uniforms.gain.value.copy(this.liveGain);
  }

  update(face, active) {
    const show = active && face.visible && !!this.texture;
    this.mesh.visible = show;
  }
}

function clampGain(g) { return Math.max(0.5, Math.min(1.8, g || 1)); }

// Puntos de piel: mejillas, frente, nariz.
export const SKIN_POINTS = [50, 280, 151, 108, 337, 6, 205, 425];

/** Color medio de la piel alrededor de SKIN_POINTS. landmarks normalizados. */
export function sampleSkin(source, landmarks, mirrored = false) {
  const w = 96, h = Math.max(1, Math.round(96 * (source.height || source.videoHeight) / (source.width || source.videoWidth)));
  const c = sampleSkin.canvas || (sampleSkin.canvas = document.createElement('canvas'));
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (const i of SKIN_POINTS) {
    const p = landmarks[i];
    const cx = Math.round(p.x * (w - 1)), cy = Math.round(p.y * (h - 1));
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const k = (y * w + x) * 4;
      r += data[k]; g += data[k + 1]; b += data[k + 2]; n++;
    }
  }
  if (!n) return null;
  return [r / n + 1, g / n + 1, b / n + 1];
}
