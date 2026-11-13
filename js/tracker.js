// Envoltorio de MediaPipe Face Landmarker (vídeo en vivo + imágenes de referencia).
import { FaceLandmarker, FilesetResolver } from '../vendor/mediapipe/vision_bundle.mjs';

const WASM_PATH = new URL('../vendor/mediapipe/wasm', import.meta.url).href;
const MODEL_PATH = new URL('../models/face_landmarker.task', import.meta.url).href;

let filesetPromise = null;
function getFileset() {
  if (!filesetPromise) filesetPromise = FilesetResolver.forVisionTasks(WASM_PATH);
  return filesetPromise;
}

async function create(runningMode, withBlendshapes) {
  const fileset = await getFileset();
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode,
    numFaces: 1,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    outputFaceBlendshapes: withBlendshapes,
    outputFacialTransformationMatrixes: false,
  });
  try {
    return await FaceLandmarker.createFromOptions(fileset, opts('GPU'));
  } catch (err) {
    console.warn('GPU no disponible para MediaPipe, usando CPU', err);
    return await FaceLandmarker.createFromOptions(fileset, opts('CPU'));
  }
}

let videoLandmarker = null;
let imageLandmarker = null;

export async function initVideoTracker() {
  if (!videoLandmarker) videoLandmarker = await create('VIDEO', true);
  return videoLandmarker;
}

let lastTs = -1;
/** Devuelve { landmarks: [{x,y,z}...478], blendshapes: {nombre: valor} } o null. */
export function detectVideo(video, nowMs) {
  if (!videoLandmarker) return null;
  const ts = nowMs <= lastTs ? lastTs + 1 : nowMs;
  lastTs = ts;
  const res = videoLandmarker.detectForVideo(video, ts);
  if (!res.faceLandmarks || res.faceLandmarks.length === 0) return null;
  const blend = {};
  const cats = res.faceBlendshapes?.[0]?.categories;
  if (cats) for (const c of cats) blend[c.categoryName] = c.score;
  return { landmarks: res.faceLandmarks[0], blendshapes: blend };
}

/** Detecta la cara en una imagen (canvas/img). Devuelve landmarks normalizados o null. */
export async function detectImage(source) {
  if (!imageLandmarker) imageLandmarker = await create('IMAGE', false);
  const res = imageLandmarker.detect(source);
  if (!res.faceLandmarks || res.faceLandmarks.length === 0) return null;
  return res.faceLandmarks[0].map((p) => ({ x: p.x, y: p.y, z: p.z }));
}

export const CONNECTIONS = {
  oval: FaceLandmarker.FACE_LANDMARKS_FACE_OVAL,
  leftEye: FaceLandmarker.FACE_LANDMARKS_LEFT_EYE,
  rightEye: FaceLandmarker.FACE_LANDMARKS_RIGHT_EYE,
  lips: FaceLandmarker.FACE_LANDMARKS_LIPS,
};
