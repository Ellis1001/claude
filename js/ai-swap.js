// Modo IA: intercambio de cara con red neuronal (inswapper) ejecutada en la GPU con WebGPU.
import * as ort from '../vendor/ort/ort.webgpu.min.mjs';

ort.env.wasm.wasmPaths = new URL('../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
ort.env.logLevel = 'error';

const MODELS = new URL('../models/', import.meta.url).href;
// Pesos de la red en media precisión (fp16), troceados; los comparten dos grafos:
// swap16.onnx (GPU con soporte fp16, más rápido) y swap32.onnx (cualquier GPU; los pesos se expanden a fp32 al cargar).
const SWAP_WEIGHTS = ['swap_w16.bin.part0', 'swap_w16.bin.part1', 'swap_w16.bin.part2'];
const ARCFACE = ['arcface_fp16.onnx'];

// Plantillas de alineación (5 puntos: ojos, nariz, comisuras) de ArcFace.
const T112 = [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]];
const T128 = [[0.36167656, 0.40387734], [0.63696719, 0.40235469], [0.50019687, 0.56044219], [0.37710391, 0.72180157], [0.62379531, 0.72057422]]
  .map(([x, y]) => [x * 128, y * 128]);

const N = 468;

/** Los 5 puntos clave en píxeles a partir de los landmarks de MediaPipe (478 con iris). */
function fivePoints(lm, w, h) {
  return [468, 473, 1, 61, 291].map((i) => [lm[i].x * w, lm[i].y * h]);
}

/** Transformación de semejanza (escala+rotación+traslación) por mínimos cuadrados: src -> dst. */
function similarity(src, dst) {
  const n = src.length;
  let mx = 0, my = 0, ux = 0, uy = 0;
  for (let i = 0; i < n; i++) { mx += src[i][0]; my += src[i][1]; ux += dst[i][0]; uy += dst[i][1]; }
  mx /= n; my /= n; ux /= n; uy /= n;
  let sa = 0, sb = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const xs = src[i][0] - mx, ys = src[i][1] - my, xd = dst[i][0] - ux, yd = dst[i][1] - uy;
    sa += xs * xd + ys * yd; sb += xs * yd - ys * xd; ss += xs * xs + ys * ys;
  }
  const a = sa / ss, b = sb / ss;
  return { a, b, tx: ux - (a * mx - b * my), ty: uy - (b * mx + a * my) };
}

const cropCanvas = document.createElement('canvas');
function alignedCrop(source, w, h, M, size) {
  cropCanvas.width = cropCanvas.height = size;
  const ctx = cropCanvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.setTransform(M.a, M.b, -M.b, M.a, M.tx, M.ty);
  ctx.drawImage(source, 0, 0, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return ctx.getImageData(0, 0, size, size).data;
}

function toCHW(rgba, size, scale, offset) {
  const n = size * size;
  const out = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    out[i] = rgba[i * 4] * scale + offset;
    out[n + i] = rgba[i * 4 + 1] * scale + offset;
    out[2 * n + i] = rgba[i * 4 + 2] * scale + offset;
  }
  return out;
}

async function fetchBytes(files, onProgress) {
  const chunks = [];
  let loaded = 0, total = 0;
  for (const f of files) {
    const res = await fetch(MODELS + f);
    if (!res.ok) throw new Error(`No se pudo descargar ${f} (${res.status})`);
    const len = +res.headers.get('content-length') || 0;
    total = total || len * files.length;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      onProgress?.(Math.min(0.99, loaded / (total || loaded)));
    }
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function createSession(model, eps, externalData) {
  let lastErr;
  for (const ep of eps) {
    try {
      const session = await ort.InferenceSession.create(model, { executionProviders: [ep], graphOptimizationLevel: 'all', externalData });
      return { session, ep };
    } catch (err) { lastErr = err; console.warn(`ONNX Runtime: ${ep} no disponible`, err); }
  }
  throw lastErr;
}

/** Expande números fp16 a fp32 (con tabla de 65536 entradas). */
function halfToFloat(bytes) {
  const table = new Float32Array(65536);
  for (let h = 0; h < 65536; h++) {
    const sign = h & 0x8000 ? -1 : 1, exp = (h >> 10) & 0x1f, frac = h & 0x3ff;
    table[h] = exp === 0 ? sign * 2 ** -14 * (frac / 1024)
      : exp === 31 ? (frac ? NaN : sign * Infinity)
      : sign * 2 ** (exp - 15) * (1 + frac / 1024);
  }
  const src = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) out[i] = table[src[i]];
  return new Uint8Array(out.buffer);
}

async function gpuInfo() {
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    return adapter ? { gpu: true, f16: adapter.features.has('shader-f16') } : { gpu: false, f16: false };
  } catch { return { gpu: false, f16: false }; }
}

/** Calcula la "identidad" (embedding de 512 números) de la cara de una foto. Se hace una vez por foto. */
export async function computeEmbedding(canvas, landmarks, onProgress) {
  const bytes = await fetchBytes(ARCFACE, onProgress);
  const { session } = await createSession(bytes, ['wasm']); // solo se usa una vez por foto: basta la CPU
  try {
    const M = similarity(fivePoints(landmarks, canvas.width, canvas.height), T112);
    const rgba = alignedCrop(canvas, canvas.width, canvas.height, M, 112);
    const input = new ort.Tensor('float32', toCHW(rgba, 112, 1 / 127.5, -1), [1, 3, 112, 112]);
    const out = await session.run({ [session.inputNames[0]]: input });
    return Float32Array.from(out[session.outputNames[0]].data);
  } finally {
    await session.release().catch(() => {});
  }
}

export class AISwapper {
  constructor() {
    this.session = null;
    this.ep = null;
    this.emap = null;
    this.source = null; // tensor [1,512]
    this.busy = false;
    this.fps = 0;
    this.loading = null;
    this.generation = 0;
  }

  get ready() { return !!this.session; }

  load(onProgress) {
    if (!this.loading) {
      this.loading = (async () => {
        const [w16, emapBuf, info] = await Promise.all([
          fetchBytes(SWAP_WEIGHTS, onProgress),
          fetch(MODELS + 'emap.bin').then((r) => r.arrayBuffer()),
          gpuInfo(),
        ]);
        this.emap = new Float32Array(emapBuf);
        ort.env.webgpu.powerPreference = 'high-performance';
        const graph = async (name) => new Uint8Array(await (await fetch(MODELS + name)).arrayBuffer());
        let made = null;
        if (info.gpu && info.f16) {
          try {
            made = await createSession(await graph('swap16.onnx'), ['webgpu'], [{ path: 'w16.bin', data: w16 }]);
            this.precision = 'fp16';
          } catch (err) { console.warn('La variante fp16 no funcionó en esta GPU', err); }
        }
        if (!made) {
          const w32 = halfToFloat(w16);
          made = await createSession(await graph('swap32.onnx'), info.gpu ? ['webgpu', 'wasm'] : ['wasm'], [{ path: 'w32.bin', data: w32 }]);
          this.precision = 'fp32';
        }
        this.session = made.session;
        this.ep = made.ep;
      })().catch((err) => { this.loading = null; throw err; });
    }
    return this.loading;
  }

  /** Fija la cara de origen a partir de su embedding de ArcFace. */
  setSource(embedding) {
    this.generation++;
    if (!embedding || !this.emap) { this.source = null; return; }
    let norm = 0;
    for (let i = 0; i < 512; i++) norm += embedding[i] * embedding[i];
    norm = Math.sqrt(norm) || 1;
    const latent = new Float32Array(512);
    for (let i = 0; i < 512; i++) {
      const e = embedding[i];
      if (e === 0) continue;
      const row = i * 512;
      for (let j = 0; j < 512; j++) latent[j] += e * this.emap[row + j];
    }
    for (let j = 0; j < 512; j++) latent[j] /= norm;
    this.source = new ort.Tensor('float32', latent, [1, 512]);
  }

  /**
   * Si no hay una inferencia en curso, lanza una con el fotograma actual.
   * onResult(rgba 128x128, uv[468*2]) recibe la cara generada y dónde cae cada punto de la malla en ella.
   */
  maybeRun(video, lm, w, h, onResult) {
    if (this.busy || !this.session || !this.source) return;
    this.busy = true;
    const gen = this.generation;
    const t0 = performance.now();
    const M = similarity(fivePoints(lm, w, h), T128);
    const rgba = alignedCrop(video, w, h, M, 128);
    const uv = new Float32Array(N * 2);
    for (let i = 0; i < N; i++) {
      const x = lm[i].x * w, y = lm[i].y * h;
      uv[i * 2] = (M.a * x - M.b * y + M.tx) / 128;
      uv[i * 2 + 1] = (M.b * x + M.a * y + M.ty) / 128;
    }
    const target = new ort.Tensor('float32', toCHW(rgba, 128, 1 / 255, 0), [1, 3, 128, 128]);
    this.session.run({ target, source: this.source }).then((res) => {
      const o = res.output.data;
      const n = 128 * 128;
      const out = new Uint8Array(n * 4);
      for (let i = 0; i < n; i++) {
        out[i * 4] = Math.max(0, Math.min(255, o[i] * 255));
        out[i * 4 + 1] = Math.max(0, Math.min(255, o[n + i] * 255));
        out[i * 4 + 2] = Math.max(0, Math.min(255, o[2 * n + i] * 255));
        out[i * 4 + 3] = 255;
      }
      const dt = performance.now() - t0;
      this.fps = this.fps ? this.fps * 0.8 + (1000 / dt) * 0.2 : 1000 / dt;
      if (gen === this.generation) onResult(out, uv);
    }).catch((err) => console.error('Error en la red de intercambio', err))
      .finally(() => { this.busy = false; });
  }
}
