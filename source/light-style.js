import * as T from 'three';

// Light style: every lit material in the scene is pulled towards a calm, near-white palette — colours keep a
// trace of their hue and their relative lightness, so parts stay readable, but nothing stands out.
// Left alone: glowing parts (LEDs, status lights, scanner strips), unlit overlays (highlights, lanes, routes)
// and materials flagged with userData.keepColour (zone floors, which carry their own soft tint).
const SATURATION = .18, FLOOR = .74, RANGE = .24;
const done = new WeakSet(), hsl = {};

function soften(m) {
  if (done.has(m)) return;
  done.add(m);
  if (!m.isMeshStandardMaterial || m.userData.keepColour || !m.color) return;
  if (m.emissive && m.emissiveIntensity > 0 && m.emissive.getHex() !== 0) return;
  m.color.getHSL(hsl);
  m.color.setHSL(hsl.h, hsl.s * SATURATION, FLOOR + hsl.l * RANGE);
  m.metalness = Math.min(m.metalness ?? 0, .15);
  m.roughness = Math.max(m.roughness ?? 1, .6);
}

export function lightStyle(root) {
  root.traverse(o => {
    if (!o.material) return;
    if (Array.isArray(o.material)) o.material.forEach(soften); else soften(o.material);
  });
}

// Instance colours (box shades) go the same way.
export function softColour(c) {
  const out = new T.Color(c);
  out.getHSL(hsl);
  return out.setHSL(hsl.h, hsl.s * SATURATION, FLOOR + hsl.l * RANGE);
}
