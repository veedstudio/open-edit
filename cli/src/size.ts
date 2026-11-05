// A picture's size as a command takes it and as an H.264 encode accepts it. Kept apart from the commands that use it,
// so the renderer can read a zone's canvas without loading the commands that cut and join video.

export interface Size {
  width: number;
  height: number;
}

// Even dimensions: yuv420p chroma is subsampled 2x, and an odd width or height makes the encoder fail
// with a message that says nothing about the real cause.
export function evenSize(size: Size): Size {
  return { width: Math.max(2, size.width - (size.width % 2)), height: Math.max(2, size.height - (size.height % 2)) };
}

export function parseCanvas(text: string): Size {
  const m = /^(\d+)x(\d+)$/.exec(text.trim());
  if (!m) throw new Error(`--canvas expects WIDTHxHEIGHT, got "${text}"`);
  return evenSize({ width: Number(m[1]), height: Number(m[2]) });
}
