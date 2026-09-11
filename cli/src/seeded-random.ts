// The seeded-draw law: the same run key must produce the same pick, across codebases.
// This mirrors pipeline/scripts/sample-style.ts in the Open Edit repository — the two
// copies must never disagree (a re-roll would silently change a delivered pick), so
// tests/seeded-random.test.ts pins them with shared vectors.

// FNV-1a over the key: a stable 32-bit seed from a human-meaningful name.
export function seedFromKey(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

// mulberry32 — tiny deterministic PRNG.
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
