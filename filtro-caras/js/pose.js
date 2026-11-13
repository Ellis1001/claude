// Convierte landmarks normalizados a coordenadas de escena y calcula la pose de la cabeza.
import * as THREE from 'three';

const N = 468; // usamos solo la malla (sin iris)

// Puntos rígidos (simétricos) para estimar el centro de la cabeza.
const RIGID = [33, 263, 133, 362, 168, 6, 197, 195, 5, 4, 1, 10, 151, 9, 234, 454, 152];
const CANON_EYE_DIST = 8.891718; // distancia 33-263 en el modelo canónico (cm)

export class FaceState {
  constructor() {
    this.world = new Float32Array(N * 3); // posiciones suavizadas en coordenadas de escena
    this.hasPrev = false;
    this.visible = false;
    this.lostFrames = 999;
    this.blendshapes = {};
    // pose
    this.origin = new THREE.Vector3();
    this.rotation = new THREE.Matrix4();
    this.quaternion = new THREE.Quaternion();
    this.unitsPerCm = 1;
    this.matrix = new THREE.Matrix4();
  }

  /**
   * @param det resultado de detectVideo
   * @param W,H tamaño del lienzo; mirrored = imagen en espejo (cámara frontal)
   * @param smoothing 0..1 (0 = sin suavizado)
   */
  update(det, W, H, mirrored, smoothing) {
    if (!det) {
      this.lostFrames++;
      if (this.lostFrames > 4) { this.visible = false; this.hasPrev = false; }
      return;
    }
    this.lostFrames = 0;
    this.visible = true;
    const lm = det.landmarks;
    const w = this.world;

    // Suavizado adaptativo: si la cara se mueve rápido, se suaviza menos (menos retraso).
    let alpha = 1;
    if (this.hasPrev && smoothing > 0) {
      const i = 168 * 3;
      const nx = mirrored ? (0.5 - lm[168].x) * W : (lm[168].x - 0.5) * W;
      const ny = (0.5 - lm[168].y) * H;
      const eye = Math.hypot((lm[33].x - lm[263].x) * W, (lm[33].y - lm[263].y) * H) || 1;
      const speed = Math.hypot(nx - w[i], ny - w[i + 1]) / eye; // movimiento relativo al tamaño de la cara
      const base = 1 - 0.85 * smoothing;
      alpha = Math.min(1, base + speed * 4);
    }

    for (let k = 0; k < N; k++) {
      const p = lm[k];
      const x = mirrored ? (0.5 - p.x) * W : (p.x - 0.5) * W;
      const y = (0.5 - p.y) * H;
      const z = -p.z * W;
      const j = k * 3;
      if (this.hasPrev && alpha < 1) {
        w[j] += (x - w[j]) * alpha;
        w[j + 1] += (y - w[j + 1]) * alpha;
        w[j + 2] += (z - w[j + 2]) * alpha;
      } else {
        w[j] = x; w[j + 1] = y; w[j + 2] = z;
      }
    }
    this.hasPrev = true;

    // blendshapes suavizados ligeramente
    const b = det.blendshapes || {};
    const ba = this.blendshapes;
    for (const k in b) ba[k] = ba[k] === undefined ? b[k] : ba[k] + (b[k] - ba[k]) * 0.6;

    this._computePose(mirrored);
  }

  point(i, out = new THREE.Vector3()) {
    const j = i * 3;
    return out.set(this.world[j], this.world[j + 1], this.world[j + 2]);
  }

  _computePose(mirrored) {
    const P = (i) => this.point(i);
    // Eje X: promedio de varios pares izquierda/derecha.
    const pairs = [[33, 263], [133, 362], [234, 454], [61, 291], [70, 300]];
    const xAxis = new THREE.Vector3();
    for (const [r, l] of pairs) {
      const d = mirrored ? P(r).sub(P(l)) : P(l).sub(P(r));
      xAxis.add(d.normalize());
    }
    xAxis.normalize();
    const up = P(10).sub(P(152)).add(P(9).sub(P(200)));
    const yAxis = up.sub(xAxis.clone().multiplyScalar(up.dot(xAxis))).normalize();
    const zAxis = new THREE.Vector3().crossVectors(xAxis, yAxis).normalize();
    this.rotation.makeBasis(xAxis, yAxis, zAxis);
    this.quaternion.setFromRotationMatrix(this.rotation);

    const eyeDist = P(33).distanceTo(P(263));
    this.unitsPerCm = eyeDist / CANON_EYE_DIST;

    // Centro: media de puntos rígidos menos su offset canónico (rotado y escalado).
    const mean = new THREE.Vector3();
    for (const i of RIGID) mean.add(P(i));
    mean.multiplyScalar(1 / RIGID.length);
    const canonMean = new THREE.Vector3(0, 1.732, 4.387); // media canónica de RIGID (cm)
    canonMean.applyMatrix4(this.rotation).multiplyScalar(this.unitsPerCm);
    this.origin.copy(mean).sub(canonMean);

    const s = this.unitsPerCm;
    this.matrix.compose(this.origin, this.quaternion, new THREE.Vector3(s, s, s));
  }
}
