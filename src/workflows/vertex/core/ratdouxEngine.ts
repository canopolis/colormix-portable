/**
 * Motor ratdoux (Snapmaker Orca FullSpectrum v0.9.18) for ColorMix portable.
 * ----------------------------------------------------------------------------
 * Colour prediction: the unmodified v0.9.18 FullSpectrum KM/K-S spectral model,
 * compiled to WebAssembly (cpp/ folder, built by GitHub Actions).
 * Colour choice: the v0.9.18 ContinuousColorSolver score (Oklab with
 * chroma-dependent axis weights and the dark penalty, "SoftCap4Dark4").
 *
 * Only printable PrusaSlicer recipes are considered (the same candidate list
 * the app already builds: up to 3 filaments, chosen recipe resolution), so the
 * exported 3MF stays valid for PrusaSlicer ColorMix.
 */
import type { RGB } from "./types";
import createColorinWasm from "./ratdoux/colorinWasm.js";

type CmPredict = (hexList: string, unitList: string) => number;

let predictFn: CmPredict | null = null;
let initError: string | null = null;

export const ratdouxReady: Promise<boolean> = (async () => {
  try {
    const mod = await createColorinWasm();
    predictFn = mod.cwrap("cm_predict", "number", ["string", "string"]) as unknown as CmPredict;
    return true;
  } catch (err) {
    initError = String(err);
    console.error("[ratdoux] no se pudo cargar el motor:", err);
    return false;
  }
})();

export function isRatdouxReady(): boolean {
  return predictFn !== null;
}

export function ratdouxInitError(): string | null {
  return initError;
}

const predictCache = new Map<string, RGB | null>();

/** Predicted printed colour of a recipe (v0.9.18 model). units[i] belongs to hexes[i]. */
export function ratdouxPredict(hexes: string[], units: number[]): RGB | null {
  if (!predictFn) return null;
  const hexList = hexes.join(",");
  const unitList = units.map((u) => String(Math.max(0, Math.round(u)))).join(",");
  const key = hexList + "|" + unitList;
  const cached = predictCache.get(key);
  if (cached !== undefined) return cached;
  const packed = predictFn(hexList, unitList);
  const rgb: RGB | null =
    packed < 0 ? null : [(packed >> 16) & 255, (packed >> 8) & 255, packed & 255];
  predictCache.set(key, rgb);
  return rgb;
}

// ---- v0.9.18 ImageMap/ContinuousColorSolver.cpp scoring (exact port) ----
const OKLAB_MIN_L_WEIGHT = 1;
const OKLAB_MAX_AB_WEIGHT = 4;
const DARK_PENALTY = 4;
const DARK_TOLERANCE = 0.04;

function clamp01(v: number): number {
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

function srgbToLinear(v: number): number {
  const x = clamp01(v);
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

export type Oklab = [number, number, number];

export function oklabFromRgb255(rgb: RGB): Oklab {
  const r = srgbToLinear(rgb[0] / 255);
  const g = srgbToLinear(rgb[1] / 255);
  const b = srgbToLinear(rgb[2] / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function chromaFactor(t: Oklab): number {
  return Math.min(1, Math.max(0, (Math.hypot(t[1], t[2]) - 0.015) / 0.13));
}

function axisWeights(t: Oklab): Oklab {
  const cf = chromaFactor(t);
  return [
    Math.max(OKLAB_MIN_L_WEIGHT, 1 + (0.25 - 1) * cf),
    Math.min(OKLAB_MAX_AB_WEIGHT, 1.25 + (8 - 1.25) * cf),
    Math.min(OKLAB_MAX_AB_WEIGHT, 1.25 + (8 - 1.25) * cf),
  ];
}

/** ContinuousColorSolver candidate_error(): lower is better. */
export function ratdouxError(target: Oklab, candidate: Oklab): number {
  const w = axisWeights(target);
  const dl = candidate[0] - target[0];
  const da = candidate[1] - target[1];
  const db = candidate[2] - target[2];
  let e = w[0] * dl * dl + w[1] * da * da + w[2] * db * db;
  const underL = Math.max(0, target[0] - candidate[0] - DARK_TOLERANCE);
  e += DARK_PENALTY * chromaFactor(target) * underL * underL;
  return e;
}
