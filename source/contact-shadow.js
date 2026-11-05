import * as T from 'three';

// Soft contact shadows: a blurred dark rectangle on the floor under racks and robots. It grounds them the way
// ambient occlusion does, for the cost of one transparent quad each (instanced for racks), not a second render.
let texture = null;
function shadowTexture() {
  if (texture || typeof document === 'undefined') return texture; // no canvas in the node tests
  const size = 128, pad = 28, c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  // shadowBlur works in every browser (ctx.filter does not in older Safari): the rectangle is drawn off-canvas and
  // only its blurred shadow lands on it.
  ctx.shadowColor = '#000'; ctx.shadowBlur = 18; ctx.shadowOffsetX = size;
  ctx.fillRect(pad - size, pad, size - pad * 2, size - pad * 2);
  texture = new T.CanvasTexture(c);
  return texture;
}

// The quad's share of the texture that the dark core covers: a footprint of w×d needs a quad of w/CORE × d/CORE.
export const CORE = (128 - 28 * 2) / 128;

let material = null;
export function contactShadowMaterial() {
  material ||= new T.MeshBasicMaterial({map: shadowTexture(), color: 0x000000, transparent: true, opacity: .32, depthWrite: false, toneMapped: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2});
  return material;
}

// A flat unit quad lying on the floor, facing up.
export const contactShadowGeometry = new T.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
