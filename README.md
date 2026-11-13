# Filtro Caras

App web instalable (PWA) para el móvil que te pone otra cara o un muñeco 3D en tiempo real con la cámara.

## Cómo funciona

1. **Pantalla de configuración**: eliges cómo quieres salir, con vista previa en vivo.
   - **Foto de cara + Modo IA** (por defecto): una red neuronal de intercambio de caras regenera el rostro de la persona enfocada con la identidad de la foto, conservando su expresión y la luz. Corre en la GPU del teléfono con WebGPU.
   - **Foto de cara sin IA**: la cara de la foto se estira sobre la malla facial (más ligero, menos realista).
   - **Imagen sin cara** (por ejemplo un dibujo PNG con transparencia): se usa como máscara que sigue tu cabeza.
   - **Modelo 3D `.glb`**: se coloca como cabeza. Si tiene blendshapes con nombres ARKit (`jawOpen`, `eyeBlinkLeft`…), copia tus expresiones.
   - **Muñeco** incluido, que parpadea, abre la boca y sonríe contigo.
2. **Empezar** → vídeo a pantalla completa, limpio y sin botones.
   - Mantén pulsado ~1 s: empieza / para la grabación (vídeo con sonido).
   - Toca dos veces o pulsa atrás: vuelve a la configuración.

Los aspectos que añades se guardan en el teléfono (IndexedDB). Nada se sube a ningún servidor: todo el procesamiento es local.

## Instalarla en el teléfono

La cámara solo funciona desde una dirección `https://`. Con GitHub Pages:

1. En el repositorio: **Settings → Pages → Build and deployment → Deploy from a branch**, elige la rama y la carpeta `/ (root)`.
2. Abre en Chrome del teléfono `https://<usuario>.github.io/<repo>/filtro-caras/`.
3. Menú ⋮ de Chrome → **Añadir a pantalla de inicio / Instalar aplicación**.

## Probar en el ordenador

```bash
cd filtro-caras && python3 -m http.server 8000
```

y abre `http://localhost:8000`.

## Modo IA

- La primera vez descarga el modelo (unos 370 MB en total) y lo guarda en el teléfono; después funciona sin conexión.
- La red genera la cara a 128×128 px varias veces por segundo; entre una y otra, la última cara generada se deforma sobre la malla facial para que el movimiento siga fluido.
- En los ajustes se ve el estado (`IA activa (GPU fp16) · N caras/s`). Si pone CPU, el navegador no tiene WebGPU y será demasiado lento: desactiva el Modo IA.
- Modelos: `inswapper_128` y `arcface_w600k_r50` de [InsightFace](https://github.com/deepinsight/insightface), cuya licencia es **solo para uso no comercial / investigación**. Los pesos están convertidos a fp16 y troceados en `models/`.
- Usa solo caras de personas que te hayan dado permiso.

## Tecnología

- [ONNX Runtime Web](https://onnxruntime.ai) (WebGPU) para la red de intercambio de caras.

- [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) (468 puntos + 52 blendshapes), incluido en `vendor/` y `models/`.
- [three.js](https://threejs.org) para dibujar la máscara y los modelos 3D.
- Sin compilación: HTML + módulos ES.
