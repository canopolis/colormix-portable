import type { MeshModel, RGB } from "./types";
import { rgbToLab, type LAB } from "./prusaFdmMixer";

/**
 * Colour zones
 * ------------
 * A zone is a set of triangles that the user wants printed in ONE chosen
 * colour (lips, hair, boots, a dress...). The user clicks points on the
 * model; the zone grows from those points over touching triangles of a
 * similar colour ("connected" mode), or takes every triangle of a similar
 * colour anywhere on the model ("global" mode, useful for skin that is split
 * by clothing). The edge can then be grown or shrunk one ring of triangles at
 * a time.
 */

export type ZoneMode = "connected" | "global";

export interface ZonePoint {
  triangle: number;
  rgb: RGB;
}

export interface ColourZone {
  id: string;
  name: string;
  mode: ZoneMode;
  points: ZonePoint[];
  protect: RGB[];
  tolerance: number;
  grow: number;
  colour: RGB;
}

export interface TriangleAdjacency {
  /** Canonical (position-welded) vertex index of each triangle corner. */
  corners: Int32Array;
  /** CSR offsets: triangles touching canonical vertex v are tris[offsets[v]..offsets[v+1]). */
  offsets: Int32Array;
  tris: Int32Array;
}

/**
 * Triangles are neighbours when they share a vertex. Vertices are welded by
 * position first, so OBJ files with duplicated seam vertices still connect.
 */
export function buildTriangleAdjacency(model: MeshModel): TriangleAdjacency {
  const canonical = new Int32Array(model.vertices.length);
  const byPosition = new Map<string, number>();
  let next = 0;
  for (let v = 0; v < model.vertices.length; v++) {
    const p = model.vertices[v];
    const key = `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)},${Math.round(p[2] * 1e4)}`;
    let id = byPosition.get(key);
    if (id === undefined) {
      id = next++;
      byPosition.set(key, id);
    }
    canonical[v] = id;
  }
  const triCount = model.triangles.length;
  const corners = new Int32Array(triCount * 3);
  const counts = new Int32Array(next + 1);
  for (let t = 0; t < triCount; t++) {
    const tri = model.triangles[t];
    for (let k = 0; k < 3; k++) {
      const c = canonical[tri[k]] ?? 0;
      corners[t * 3 + k] = c;
      counts[c + 1]++;
    }
  }
  const offsets = new Int32Array(next + 1);
  for (let v = 0; v < next; v++) offsets[v + 1] = offsets[v] + counts[v + 1];
  const fill = offsets.slice(0, next);
  const tris = new Int32Array(triCount * 3);
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const c = corners[t * 3 + k];
      tris[fill[c]++] = t;
    }
  }
  return { corners, offsets, tris };
}

function forEachNeighbour(
  adj: TriangleAdjacency,
  t: number,
  visit: (n: number) => void,
): void {
  for (let k = 0; k < 3; k++) {
    const v = adj.corners[t * 3 + k];
    for (let p = adj.offsets[v]; p < adj.offsets[v + 1]; p++) {
      const n = adj.tris[p];
      if (n !== t) visit(n);
    }
  }
}

/**
 * Distance used to decide whether a colour belongs to a zone. Lightness
 * (shading baked into the texture) counts much less than hue and chroma, so
 * lit and shaded parts of the same material stay together while a different
 * material (lips vs skin, hair vs skin) is kept apart.
 */
export function zoneDistance(a: LAB, b: LAB): number {
  const dL = (a.L - b.L) * 0.35;
  const da = a.a - b.a;
  const db = a.b - b.b;
  return Math.sqrt(dL * dL + da * da + db * db);
}

/** Returns a cached classifier: true when a colour belongs to the zone. */
function makeClassifier(
  zone: ColourZone,
): (rgb: RGB) => boolean {
  const seedLab = zone.points.map((p) => rgbToLab(p.rgb));
  const protectLab = zone.protect.map((c) => rgbToLab(c));
  const cache = new Map<number, boolean>();
  return (c: RGB) => {
    const key =
      (Math.round(c[0]) << 16) | (Math.round(c[1]) << 8) | Math.round(c[2]);
    let value = cache.get(key);
    if (value === undefined) {
      const lab = rgbToLab(c);
      let toZone = Number.POSITIVE_INFINITY;
      for (const s of seedLab) toZone = Math.min(toZone, zoneDistance(lab, s));
      let toProtect = Number.POSITIVE_INFINITY;
      for (const p of protectLab)
        toProtect = Math.min(toProtect, zoneDistance(lab, p));
      value = toZone <= zone.tolerance && toZone < toProtect;
      cache.set(key, value);
    }
    return value;
  };
}

function growShrink(
  mask: Uint8Array,
  steps: number,
  adj: TriangleAdjacency,
): Uint8Array {
  let current: Uint8Array = mask;
  const grow = steps > 0;
  for (let s = 0; s < Math.abs(steps); s++) {
    const next = current.slice();
    for (let t = 0; t < current.length; t++) {
      if (grow) {
        if (!current[t]) continue;
        forEachNeighbour(adj, t, (n) => {
          next[n] = 1;
        });
      } else {
        if (!current[t]) continue;
        let edge = false;
        forEachNeighbour(adj, t, (n) => {
          if (!current[n]) edge = true;
        });
        if (edge) next[t] = 0;
      }
    }
    current = next;
  }
  return current;
}

/** 1 = triangle belongs to the zone. */
export function computeZoneMask(
  colors: RGB[],
  zone: ColourZone,
  getAdjacency: () => TriangleAdjacency | null,
): Uint8Array {
  const n = colors.length;
  let mask: Uint8Array = new Uint8Array(n);
  if (zone.points.length === 0 || n === 0) return mask;
  const belongs = makeClassifier(zone);

  if (zone.mode === "global") {
    for (let t = 0; t < n; t++) {
      const c = colors[t];
      if (c && belongs(c)) mask[t] = 1;
    }
  } else {
    const adj = getAdjacency();
    if (!adj) return mask;
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    for (const p of zone.points) {
      if (p.triangle < 0 || p.triangle >= n || mask[p.triangle]) continue;
      mask[p.triangle] = 1;
      queue[tail++] = p.triangle;
    }
    while (head < tail) {
      const t = queue[head++];
      forEachNeighbour(adj, t, (nb) => {
        if (mask[nb]) return;
        const c = colors[nb];
        if (!c || !belongs(c)) return;
        mask[nb] = 1;
        queue[tail++] = nb;
      });
    }
  }

  if (zone.grow !== 0) {
    const adj = getAdjacency();
    if (adj) mask = growShrink(mask, Math.max(-5, Math.min(5, zone.grow)), adj);
  }
  return mask;
}

export function countMask(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) count += mask[i];
  return count;
}

export const ZONE_NAME_PRESETS = [
  "Skin",
  "Lips",
  "Nipples",
  "Eyes",
  "Eyebrows",
  "Hair",
  "Cape",
  "Gloves",
  "Boots",
  "Suit",
  "Skirt",
  "Trousers",
  "Blouse",
  "Dress",
] as const;
