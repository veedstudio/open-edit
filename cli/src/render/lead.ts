// The first render session of a page, which settles the canvas the others capture: shared by render, which
// opens the rest of its workers on it, and by behind, which measures on the same canvas render would draw.
import { RenderSession, type SessionOptions } from './session.ts';

// Fixed, so two renders of one page agree to the pixel: Math.random() draws the same sequence and
// Date.now() reads the same instant at frame 0 on every machine.
export const SEED = 0x5eed;
export const EPOCH = Date.UTC(2025, 0, 1);
// The longest any one wait inside the page may take: over ten times the slowest page load measured, so only a page
// that has stopped answering reaches it.
export const BUDGET_MS = 60_000;

export interface Canvas {
  width: number;
  height: number;
  /** The viewport the stage was measured in, and so the only one its clip is valid in. */
  viewport: { width: number; height: number };
  clip: SessionOptions['clip'];
}

export type SessionBase = Omit<SessionOptions, 'viewport' | 'clip' | 'canvas'>;
type Stage = NonNullable<RenderSession['info']['stage']>;

const PROBE = { width: 1920, height: 1080 };

/** A failure the user can fix by changing what they asked for: render prints its usage line after it. */
export class UsageError extends Error {}

export function sessionOptions(base: SessionBase, canvas: Canvas): SessionOptions {
  return { ...base, viewport: canvas.viewport, clip: canvas.clip, canvas: { width: canvas.width, height: canvas.height } };
}

const fitsIn = (s: Stage, v: { width: number; height: number }): boolean =>
  s.left >= 0 && s.top >= 0 && s.left + s.width <= v.width && s.top + s.height <= v.height;

function stageCanvas(s: Stage, viewport: { width: number; height: number }): Canvas {
  const whole = s.left === 0 && s.top === 0 && s.width === viewport.width && s.height === viewport.height;
  return { width: s.width, height: s.height, viewport, clip: whole ? null : { x: s.left, y: s.top, width: s.width, height: s.height } };
}

function led(canvas: Canvas, lead: RenderSession): { canvas: Canvas; lead: RenderSession } {
  lead.setClip(canvas.clip);
  return { canvas, lead };
}

const where = (s: Stage | null): string => (s ? `${s.width}x${s.height} at ${s.left},${s.top}` : 'gone');

/**
 * The first worker, opened before the others: it settles the canvas (the flags when given, else the
 * page's stage element) and reports the page's videos. The stage is captured from the viewport it was
 * measured in: a centred or viewport-sized stage moves when the viewport changes size.
 */
export async function openLead(base: SessionBase, width?: number, height?: number): Promise<{ canvas: Canvas; lead: RenderSession }> {
  if (width && height) {
    const canvas = { width, height, viewport: { width, height }, clip: null };
    return { canvas, lead: await RenderSession.open(sessionOptions(base, canvas)) };
  }
  const probe = await RenderSession.open({ ...base, viewport: PROBE, clip: null });
  const first = probe.info.stage;
  if (!first) return { canvas: { ...PROBE, viewport: PROBE, clip: null }, lead: probe };
  const inProbe = fitsIn(first, PROBE);
  if (inProbe && stageCanvas(first, PROBE).clip === null) return led(stageCanvas(first, PROBE), probe);
  // The smallest viewport that holds the stage where it sat, measured again there. The probe stays open
  // meanwhile: when the stage fits it, its own measurement is the fallback.
  const viewport = { width: Math.max(first.left, 0) + first.width, height: Math.max(first.top, 0) + first.height };
  let lead: RenderSession;
  try {
    lead = await RenderSession.open({ ...base, viewport, clip: null });
  } catch (e) {
    await probe.close();
    throw e;
  }
  const again = lead.info.stage;
  if (again && again.width === first.width && again.height === first.height && fitsIn(again, viewport)) {
    await probe.close();
    return led(stageCanvas(again, viewport), lead);
  }
  await lead.close();
  if (inProbe) return led(stageCanvas(first, PROBE), probe);
  await probe.close();
  throw new UsageError(`the page's stage is ${where(first)} in a ${PROBE.width}x${PROBE.height} viewport but ${where(again)} in ${viewport.width}x${viewport.height}: `
    + 'its size or place follows the viewport, so give it a fixed size, or pass --width/--height');
}
