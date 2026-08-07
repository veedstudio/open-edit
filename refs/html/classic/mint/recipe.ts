import { classicRecipe } from '../classic-lib.ts';

export default classicRecipe({
  id: 'mint',
  yFrac: { pt: 0.85, ls: 0.78 },
  googleFamily: 'Anton',
  fontStack: '\'Anton\', Impact, sans-serif',
  weight: 400,
  color: '#ffffffff',
  pitchEm: 1.05,
  letterSpacingEm: -0.02083,
  casing: 'uppercase',
  anim: 'colourHighlight',
  highlightColor: '#80ffc9ff',
  outline: { sizeEm: 0.03, color: '#000000' },
  shadow: { blurEm: 0.12, dxEm: 0.096, dyEm: 0.115, color: '#000000' },
  avgCharEm: 0.4,
});
