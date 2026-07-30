// HTTP Range planning for the two media endpoints. <video> seeking sends Range requests;
// without correct 206 handling, scrubbing does not work at all.
export interface RangePlan {
  status: 200 | 206 | 416;
  start: number;
  end: number; // inclusive
  headers: Record<string, string>;
}

export function planRange(rangeHeader: string | undefined, size: number): RangePlan {
  const full: RangePlan = {
    status: 200,
    start: 0,
    end: Math.max(0, size - 1),
    headers: { 'accept-ranges': 'bytes', 'content-length': String(size) },
  };
  if (!rangeHeader) return full;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!m || (m[1] === '' && m[2] === '')) return full;

  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number.parseInt(m[2], 10);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(Number.parseInt(m[2], 10), size - 1);
  }
  if (start >= size || start > end) {
    return { status: 416, start: 0, end: 0, headers: { 'content-range': `bytes */${size}` } };
  }
  return {
    status: 206,
    start,
    end,
    headers: {
      'accept-ranges': 'bytes',
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(end - start + 1),
    },
  };
}
