import * as T from 'three';
import {EffectComposer} from 'three/addons/postprocessing/EffectComposer.js';
import {RenderPass} from 'three/addons/postprocessing/RenderPass.js';
import {GTAOPass} from 'three/addons/postprocessing/GTAOPass.js';
import {OutputPass} from 'three/addons/postprocessing/OutputPass.js';

// Soft contact shadows (ambient occlusion) where things meet: under racks and robots, in shelf corners, along the
// conveyors. three's GTAO reads a standard depth buffer; this scene writes a logarithmic one (see scene.js), so the
// depth it samples is turned back into perspective depth before it is used.
const HEADER = 'vec3 getViewPosition( const in vec2 screenPosition, const in float depth ) {';
const LOG_HEADER = `vec3 getViewPosition( const in vec2 screenPosition, const in float logDepth ) {
  float depth = logDepth >= 1.0 ? 1.0 : viewZToPerspectiveDepth( 1.0 - exp2( logDepth * log2( cameraFar + 1.0 ) ), cameraNear, cameraFar );`;

function readLogDepth(material, camera) {
  if (!material.fragmentShader.includes(HEADER)) return;
  material.fragmentShader = material.fragmentShader.replace(HEADER, LOG_HEADER);
  if (!material.uniforms.cameraNear) {
    material.uniforms.cameraNear = {value: camera.near};
    material.uniforms.cameraFar = {value: camera.far};
    material.fragmentShader = 'uniform float cameraNear;\nuniform float cameraFar;\n' + material.fragmentShader;
  }
  material.needsUpdate = true;
}

export function createAmbientOcclusion(renderer, scene, camera) {
  const size = renderer.getSize(new T.Vector2());
  // Multisampled, so edges stay as smooth as with the renderer's own antialiasing.
  const target = new T.WebGLRenderTarget(1, 1, {type: T.HalfFloatType, samples: 4});
  const composer = new EffectComposer(renderer, target);
  const gtao = new GTAOPass(scene, camera, size.x, size.y);
  gtao.updateGtaoMaterial({radius: .9, distanceExponent: 1.5, thickness: 1.5, scale: 1.1, samples: 12, distanceFallOff: 1, screenSpaceRadius: false});
  gtao.updatePdMaterial({lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12});
  gtao.blendIntensity = .85;
  if (renderer.capabilities.logarithmicDepthBuffer) { readLogDepth(gtao.gtaoMaterial, camera); readLogDepth(gtao.pdMaterial, camera); }
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
  const ao = {
    // Off, the pass is skipped but the output stays the same (tone mapping in OutputPass), so the floor does not change shade.
    get enabled() { return gtao.enabled; },
    set enabled(on) { gtao.enabled = on; },
    render() {
      const near = gtao.pdMaterial.uniforms.cameraNear;
      if (near) { near.value = camera.near; gtao.pdMaterial.uniforms.cameraFar.value = camera.far; }
      composer.render();
    },
    setSize(w, h) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); },
  };
  return ao;
}
