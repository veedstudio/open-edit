// The platform-safe area type is placed in, as canvas fractions. One definition: the safe-zone gate,
// the placement measurement and the brief's margins all mean these numbers, and a second copy is how
// a gate ends up measuring against a zone the author was never told about.
export interface Zone { x0: number; x1: number; y0: number; y1: number }

/** 9:16 keeps the band a feed's own chrome covers clear; 16:9 and 1:1 are plain insets. */
export function safeZone(w: number, h: number): Zone {
  if (h > w) return { x0: 0.06, x1: 0.89, y0: 0.11, y1: 0.83 };
  const inset = w === h ? 0.05 : 0.06;
  return { x0: inset, x1: 1 - inset, y0: inset, y1: 1 - inset };
}
