import type {
  ColourDifferenceMetric,
  MixingRecipeResolution,
  PhysicalSlot,
  RGB,
} from "./types";
import { getBlendCandidates } from "./virtualExtruders";
import { deltaE2000, deltaE76, rgbToLab, type LAB } from "./prusaFdmMixer";

/**
 * Filament advisor
 * ----------------
 * The print simulation can only show colours that the physical filaments can
 * produce as printable mixtures. The "ceiling" is the best result any palette
 * could reach with a given filament set: the weighted mean colour difference
 * between each model colour and its closest printable mixture. Comparing the
 * ceiling of the current filaments with the ceiling after swapping one slot
 * shows which filament change would bring the print simulation closest to
 * the original model colours.
 */

export interface ColourSample {
  lab: LAB[];
  weight: number[];
}

/** Groups colours into RGB buckets (weighted mean colour per bucket). */
export function sampleColours(
  colors: RGB[],
  weights: number[] | undefined,
  bitsPerChannel: number,
): ColourSample {
  const shift = 8 - bitsPerChannel;
  const buckets = new Map<number, { r: number; g: number; b: number; w: number }>();
  const useWeights = !!weights && weights.length === colors.length;
  for (let i = 0; i < colors.length; i++) {
    const c = colors[i];
    if (!c) continue;
    const w = useWeights ? Math.max(1e-9, weights![i] || 0) : 1;
    const key =
      ((c[0] >> shift) << (2 * bitsPerChannel)) |
      ((c[1] >> shift) << bitsPerChannel) |
      (c[2] >> shift);
    const e = buckets.get(key);
    if (e) {
      e.r += c[0] * w;
      e.g += c[1] * w;
      e.b += c[2] * w;
      e.w += w;
    } else {
      buckets.set(key, { r: c[0] * w, g: c[1] * w, b: c[2] * w, w });
    }
  }
  const lab: LAB[] = [];
  const weight: number[] = [];
  for (const e of buckets.values()) {
    lab.push(rgbToLab([e.r / e.w, e.g / e.w, e.b / e.w]));
    weight.push(e.w);
  }
  return { lab, weight };
}

/**
 * Best result reachable with these filaments (weighted mean colour
 * difference to the closest printable mixture). Uses a fast ΔE76 pre-filter
 * and the selected metric on the closest few candidates.
 */
export function printableCeiling(
  sample: ColourSample,
  physicalSlots: PhysicalSlot[],
  maxComponents: 1 | 2 | 3,
  recipeResolution: MixingRecipeResolution,
  metric: ColourDifferenceMetric,
): number {
  if (physicalSlots.length === 0 || sample.lab.length === 0)
    return Number.POSITIVE_INFINITY;
  const cands = getBlendCandidates(physicalSlots, maxComponents, recipeResolution);
  if (cands.length === 0) return Number.POSITIVE_INFINITY;
  const dist = metric === "cie76" ? deltaE76 : deltaE2000;
  const KEEP = 6;
  const bestI = new Int32Array(KEEP);
  const bestD = new Float64Array(KEEP);
  let sum = 0;
  let wsum = 0;
  for (let s = 0; s < sample.lab.length; s++) {
    const lab = sample.lab[s];
    let filled = 0;
    for (let i = 0; i < cands.length; i++) {
      const c = cands[i].fdmLab;
      const dL = lab.L - c.L;
      const da = lab.a - c.a;
      const db = lab.b - c.b;
      const d = dL * dL + da * da + db * db;
      if (filled < KEEP) {
        bestI[filled] = i;
        bestD[filled] = d;
        filled++;
      } else {
        let worst = 0;
        for (let j = 1; j < KEEP; j++) if (bestD[j] > bestD[worst]) worst = j;
        if (d < bestD[worst]) {
          bestI[worst] = i;
          bestD[worst] = d;
        }
      }
    }
    let best = Number.POSITIVE_INFINITY;
    for (let j = 0; j < filled; j++) {
      const d = dist(lab, cands[bestI[j]].fdmLab);
      if (d < best) best = d;
    }
    sum += best * sample.weight[s];
    wsum += sample.weight[s];
  }
  return wsum > 0 ? sum / wsum : Number.POSITIVE_INFINITY;
}
