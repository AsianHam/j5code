/**
 * Shared geometry for the Horizon cards' scenes: a 480x176 slip of chart
 * paper with the waterline at 150 and docks whose deck is at 130. Sailors
 * stand on a deck at 1.7, boats sit on the water, and messages fly between
 * a sailor's flag tip and a boat's mast.
 */
import { routePath } from "../lib/route";

export const WIDTH = 480;
export const HEIGHT = 176;
export const WATER = 150;
export const DECK = 130;
export const SAILOR_SCALE = 1.7;

export const wave = `M0 ${WATER} Q 40 ${WATER - 6} 80 ${WATER} T 160 ${WATER} T 240 ${WATER} T 320 ${WATER} T 400 ${WATER} T 480 ${WATER}`;

export type Point = [number, number];

/** A boat drawn at `scale` with its hull on the water: where to place it and where its flag tip is. */
export const boat = (x: number, scale: number, mastLift = 2) => ({
  x,
  y: WATER - 44 * scale,
  scale,
  mast: [x + 32 * scale, WATER - 44 * scale - mastLift] as Point,
});

/** A sailor standing on the deck at `x`, facing right, or left when `flipped`; and the tip of the flag in their hand. */
export const sailor = (x: number, flipped = false) => ({
  x,
  y: DECK,
  transform: `translate(${x} ${DECK}) scale(${flipped ? -SAILOR_SCALE : SAILOR_SCALE} ${SAILOR_SCALE})`,
  flag: [x + (flipped ? -12 : 12) * SAILOR_SCALE, DECK - 34 * SAILOR_SCALE] as Point,
});

/** An arc from a to b, lifted `lift` above the higher end. */
export const arc = (a: Point, b: Point, lift: number) =>
  routePath({ from: a, control: [(a[0] + b[0]) / 2, Math.min(a[1], b[1]) - lift], to: b });
