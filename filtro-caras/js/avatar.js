// Muñecos 3D (archivos .glb/.gltf o el muñeco incluido) y "stickers" 2D que siguen la cabeza.
import * as THREE from 'three';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';

const HEAD_WIDTH_CM = 17; // ancho al que se normaliza un modelo cargado

export class AvatarLayer {
  constructor(scene) {
    this.root = new THREE.Group(); // recibe la pose de la cabeza (unidades = cm)
    this.root.matrixAutoUpdate = false;
    this.root.visible = false;
    scene.add(this.root);
    this.holder = new THREE.Group(); // ajustes del usuario (escala/altura/profundidad)
    this.root.add(this.holder);
    this.current = null; // { object, morphMeshes, animate? }
    this.settings = { scale: 1, height: 0, depth: 0, swapLR: false };

    const hemi = new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.6);
    const dir = new THREE.DirectionalLight(0xffffff, 2.2);
    dir.position.set(0.3, 0.6, 1);
    scene.add(hemi, dir);
  }

  clear() {
    if (this.current) {
      this.holder.remove(this.current.object);
      disposeObject(this.current.object);
    }
    this.current = null;
  }

  setBuiltIn() {
    this.clear();
    const doll = createDoll();
    this.holder.add(doll.object);
    this.current = doll;
  }

  async setModel(arrayBuffer) {
    const loader = new GLTFLoader();
    const gltf = await loader.parseAsync(arrayBuffer, '');
    this.clear();
    const obj = gltf.scene;
    // Normalizar tamaño y centrar.
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const s = HEAD_WIDTH_CM / Math.max(size.x, 1e-6);
    const wrap = new THREE.Group();
    obj.position.sub(center);
    wrap.add(obj);
    wrap.scale.setScalar(s);
    wrap.position.set(0, 1.5, -1);

    const morphMeshes = [];
    obj.traverse((o) => {
      if (o.isMesh) {
        o.frustumCulled = false;
        if (o.morphTargetDictionary) morphMeshes.push(o);
      }
    });
    let mixer = null;
    if (gltf.animations?.length) {
      mixer = new THREE.AnimationMixer(obj);
      mixer.clipAction(gltf.animations[0]).play();
    }
    this.holder.add(wrap);
    this.current = { object: wrap, morphMeshes, mixer };
    return { morphCount: morphMeshes.length };
  }

  setSticker(canvas) {
    this.clear();
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    const aspect = canvas.height / canvas.width;
    const w = 20;
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, w * aspect), mat);
    mesh.position.set(0, 1.5, 6);
    const g = new THREE.Group();
    g.add(mesh);
    this.holder.add(g);
    this.current = { object: g, morphMeshes: [] };
  }

  update(face, active, dt) {
    const show = active && face.visible && !!this.current;
    this.root.visible = show;
    if (!show) return;
    this.root.matrix.copy(face.matrix);
    this.root.matrixWorldNeedsUpdate = true;
    const st = this.settings;
    this.holder.scale.setScalar(st.scale);
    this.holder.position.set(0, st.height, st.depth);

    const bs = face.blendshapes;
    const get = (name) => {
      if (st.swapLR) {
        if (name.endsWith('Left')) name = name.slice(0, -4) + 'Right';
        else if (name.endsWith('Right')) name = name.slice(0, -5) + 'Left';
      }
      return bs[name] || 0;
    };
    for (const m of this.current.morphMeshes) {
      for (const name in m.morphTargetDictionary) {
        const key = normalizeMorphName(name);
        if (key in bs) {
          m.morphTargetInfluences[m.morphTargetDictionary[name]] = get(key);
        }
      }
    }
    if (this.current.animate) this.current.animate(get, dt);
    if (this.current.mixer) this.current.mixer.update(dt);
  }
}

// Acepta nombres tipo "jawOpen", "JawOpen", "blendShape.jawOpen", "eyeBlink_L"…
function normalizeMorphName(name) {
  let n = name.split('.').pop();
  n = n.replace(/_L$/, 'Left').replace(/_R$/, 'Right');
  return n.charAt(0).toLowerCase() + n.slice(1);
}

function disposeObject(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      for (const k in m) if (m[k] && m[k].isTexture) m[k].dispose();
      m.dispose();
    }
  });
}

/** Muñeco incluido, construido con geometrías simples (unidades en cm). */
function createDoll() {
  const g = new THREE.Group();
  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, ...extra });
  const skin = mat(0xffc9a3);

  const head = new THREE.Mesh(new THREE.SphereGeometry(10, 48, 32), skin);
  head.scale.set(1, 1.05, 0.95);
  head.position.set(0, 1.5, -1.5);
  g.add(head);

  // Pelo
  const hair = new THREE.Mesh(
    new THREE.SphereGeometry(10.5, 48, 32, 0, Math.PI * 2, 0, Math.PI * 0.42),
    mat(0x5a3220, { roughness: 0.8 }),
  );
  hair.position.copy(head.position);
  hair.rotation.x = -0.35;
  hair.scale.set(1.02, 1.08, 1);
  g.add(hair);

  // Orejas
  for (const sx of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.SphereGeometry(2.2, 24, 16), skin);
    ear.scale.set(0.6, 1, 0.8);
    ear.position.set(sx * 9.8, 1.5, -1.5);
    g.add(ear);
  }

  const eyeWhite = mat(0xffffff, { roughness: 0.2 });
  const irisMat = mat(0x3a7bd5, { roughness: 0.2 });
  const pupilMat = mat(0x111111, { roughness: 0.1 });
  const lidMat = skin;
  const eyes = [];
  for (const sx of [-1, 1]) {
    const eye = new THREE.Group();
    eye.position.set(sx * 3.6, 3.2, 6.3);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(2.4, 32, 24), eyeWhite);
    eye.add(ball);
    const look = new THREE.Group();
    const iris = new THREE.Mesh(new THREE.CircleGeometry(1.3, 32), irisMat);
    iris.position.z = 2.38;
    const pupil = new THREE.Mesh(new THREE.CircleGeometry(0.65, 32), pupilMat);
    pupil.position.z = 2.41;
    const shine = new THREE.Mesh(new THREE.CircleGeometry(0.3, 16), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    shine.position.set(0.45, 0.45, 2.43);
    look.add(iris, pupil, shine);
    eye.add(look);
    // Párpado: semiesfera que baja al parpadear
    const lid = new THREE.Mesh(new THREE.SphereGeometry(2.55, 32, 16, 0, Math.PI * 2, 0, Math.PI / 2), lidMat);
    lid.rotation.x = -0.9;
    eye.add(lid);
    // Ceja
    const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.35, 2.6, 4, 8), mat(0x4a2818));
    brow.rotation.z = Math.PI / 2;
    brow.position.set(0, 3.2, 1.6);
    eye.add(brow);
    g.add(eye);
    eyes.push({ eye, look, lid, brow, side: sx });
  }

  // Nariz
  const nose = new THREE.Mesh(new THREE.SphereGeometry(1.2, 24, 16), mat(0xffb48a));
  nose.position.set(0, 0, 8.4);
  g.add(nose);

  // Mejillas
  for (const sx of [-1, 1]) {
    const cheek = new THREE.Mesh(new THREE.CircleGeometry(1.4, 24), new THREE.MeshBasicMaterial({ color: 0xff8a8a, transparent: true, opacity: 0.55 }));
    cheek.position.set(sx * 5.6, -1.2, 7.05);
    cheek.rotation.y = sx * 0.6;
    g.add(cheek);
  }

  // Boca: interior oscuro + labio
  const mouth = new THREE.Group();
  mouth.position.set(0, -3.6, 7.6);
  const inner = new THREE.Mesh(new THREE.CircleGeometry(2, 32), mat(0x5c1a1a));
  inner.scale.set(1, 0.15, 1);
  const tongue = new THREE.Mesh(new THREE.CircleGeometry(1.1, 24), mat(0xe86a7a));
  tongue.position.set(0, -0.7, 0.02);
  tongue.visible = false;
  const smile = new THREE.Mesh(new THREE.TorusGeometry(2, 0.28, 8, 32, Math.PI), mat(0xc0504d));
  smile.rotation.z = Math.PI;
  mouth.add(inner, tongue, smile);
  g.add(mouth);

  const animate = (get) => {
    for (const e of eyes) {
      const side = e.side > 0 ? 'Left' : 'Right'; // +X = izquierda del muñeco
      const blink = Math.min(1, get('eyeBlink' + side) * 1.25);
      e.lid.rotation.x = -0.9 + blink * 2.47;
      const lookIn = get('eyeLookIn' + side), lookOut = get('eyeLookOut' + side);
      const lookUp = get('eyeLookUp' + side), lookDown = get('eyeLookDown' + side);
      const hx = (e.side > 0 ? -1 : 1) * (lookIn - lookOut);
      e.look.rotation.y = hx * 0.6;
      e.look.rotation.x = (lookDown - lookUp) * 0.5;
      const up = get('browInnerUp') * 0.9 + get('browOuterUp' + side) * 0.6 - get('browDown' + side) * 0.9;
      e.brow.position.y = 3.2 + up;
      e.brow.rotation.x = 0;
    }
    const jaw = get('jawOpen');
    const smileAmt = (get('mouthSmileLeft') + get('mouthSmileRight')) / 2;
    const pucker = get('mouthPucker');
    inner.scale.set(1 - pucker * 0.5 + smileAmt * 0.3, 0.15 + jaw * 1.3, 1);
    inner.position.y = -jaw * 0.8;
    tongue.visible = jaw > 0.35;
    tongue.position.y = -0.4 - jaw * 1.3;
    smile.scale.set(1 + smileAmt * 0.4 - pucker * 0.5, 0.25 + smileAmt * 0.9, 1);
    smile.position.y = -jaw * 0.5;
    const puff = get('cheekPuff');
    head.scale.set(1 + puff * 0.06, 1.05, 0.95);
  };

  return { object: g, morphMeshes: [], animate };
}
