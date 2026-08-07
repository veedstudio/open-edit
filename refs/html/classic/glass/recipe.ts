import { classicRecipe } from '../classic-lib.ts';

export default classicRecipe({
  id: 'glass',
  googleFamily: 'Inter:wght@500',
  fontStack: '\'Inter\', sans-serif',
  weight: 500,
  color: '#FFFFFF',
  pitchEm: 0.76,
  letterSpacingEm: -0.04,
  casing: 'lowercase',
  anim: 'fadeInPre',
  shadow: { blurEm: 0.4, dxEm: 0, dyEm: 0, color: '#0000002F' },
  plate: { tint: 'rgba(20,20,22,.45)', blurEm: 0.8, radiusEm: 0.7, padXEm: 0.85, padTopEm: 0.35, padBottomEm: 0.85 },
  avgCharEm: 0.44,
  sizeFrac: { pt: 0.053, ls: 0.029 },
  wrapFrac: { pt: 0.75, ls: 0.64 },
  yFrac: { pt: 0.78, ls: 0.78 },
});
