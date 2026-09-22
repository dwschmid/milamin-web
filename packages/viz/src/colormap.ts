// Colormaps for the field plots, built from the reference dataviz palette:
// - pressure: diverging blue <-> red with a neutral gray midpoint
// - max shear stress: sequential single-hue blue
// Stops are interpolated in OKLab so the ramps are perceptually even. The red
// arm of the diverging map mirrors the blue arm's lightness/chroma exactly
// (hue swapped in OKLCH), so neither side is visually louder than the other.

export type RGB = [number, number, number];
export type Colormap = (t: number) => RGB; // t in [0, 1]

// --- sRGB <-> OKLab (Björn Ottosson's reference constants) -----------------

const srgbToLinear = (u: number) => (u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (u: number) => (u <= 0.0031308 ? 12.92 * u : 1.055 * u ** (1 / 2.4) - 0.055);

type Lab = [number, number, number];

function hexToLab(hex: string): Lab {
  const n = parseInt(hex.slice(1), 16);
  const r = srgbToLinear(((n >> 16) & 255) / 255);
  const g = srgbToLinear(((n >> 8) & 255) / 255);
  const b = srgbToLinear((n & 255) / 255);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function labToRgb([L, a, b]: Lab): RGB | null {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bb = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  if (r < -1e-4 || r > 1.0001 || g < -1e-4 || g > 1.0001 || bb < -1e-4 || bb > 1.0001) return null;
  const clamp = (u: number) => Math.min(1, Math.max(0, u));
  return [
    Math.round(linearToSrgb(clamp(r)) * 255),
    Math.round(linearToSrgb(clamp(g)) * 255),
    Math.round(linearToSrgb(clamp(bb)) * 255),
  ];
}

/** OKLab -> sRGB with chroma reduction until in gamut. */
function labToRgbGamut(lab: Lab): RGB {
  let [L, a, b] = lab;
  for (let k = 0; k < 24; k++) {
    const rgb = labToRgb([L, a, b]);
    if (rgb) return rgb;
    a *= 0.92;
    b *= 0.92;
  }
  return labToRgb([L, 0, 0]) ?? [0, 0, 0];
}

/** Swap a color's OKLCH hue to that of `hueFrom`, keeping L and C. */
function withHueOf(hex: string, hueFrom: string): Lab {
  const [L, a, b] = hexToLab(hex);
  const C = Math.hypot(a, b);
  const [, ha, hb] = hexToLab(hueFrom);
  const h = Math.atan2(hb, ha);
  return [L, C * Math.cos(h), C * Math.sin(h)];
}

function makeRamp(stops: Lab[]): Colormap {
  return (t: number) => {
    const u = Math.min(1, Math.max(0, t)) * (stops.length - 1);
    const i = Math.min(stops.length - 2, Math.floor(u));
    const f = u - i;
    const A = stops[i];
    const B = stops[i + 1];
    return labToRgbGamut([
      A[0] + (B[0] - A[0]) * f,
      A[1] + (B[1] - A[1]) * f,
      A[2] + (B[2] - A[2]) * f,
    ]);
  };
}

// --- Palette stops (reference palette, blue ramp 100..700) ------------------

const BLUE = { 100: '#cde2fb', 200: '#9ec5f4', 250: '#86b6ef', 300: '#6da7ec', 400: '#3987e5', 450: '#2a78d6', 500: '#256abf', 550: '#1c5cab', 600: '#184f95', 700: '#0d366b' };
const RED_HUE = '#e34948';
const NEUTRAL = { light: '#f0efec', dark: '#383835' };

const red = (blueHex: string): Lab => withHueOf(blueHex, RED_HUE);
const lab = hexToLab;

export function divergingMap(mode: 'light' | 'dark'): Colormap {
  if (mode === 'light') {
    // dark blue -> light blue -> neutral -> light red -> dark red
    return makeRamp([
      lab(BLUE[700]), lab(BLUE[450]), lab(BLUE[250]), lab(BLUE[100]),
      lab(NEUTRAL.light),
      red(BLUE[100]), red(BLUE[250]), red(BLUE[450]), red(BLUE[700]),
    ]);
  }
  // Dark surface: neutral midpoint recedes into the surface, extremes go light.
  return makeRamp([
    lab(BLUE[200]), lab(BLUE[400]), lab(BLUE[550]),
    lab(NEUTRAL.dark),
    red(BLUE[550]), red(BLUE[400]), red(BLUE[200]),
  ]);
}

/**
 * Turbo (Google's improved jet): polynomial approximation by Anton Mikhailov.
 * Perceptually much better behaved than jet while keeping the rainbow look of
 * the original MATLAB figures. Same in light and dark mode.
 */
export function turboMap(): Colormap {
  return (t: number) => {
    const x = Math.min(1, Math.max(0, t));
    const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))));
    const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))));
    const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))));
    const q = (u: number) => Math.round(Math.min(1, Math.max(0, u)) * 255);
    return [q(r), q(g), q(b)];
  };
}

export function sequentialMap(mode: 'light' | 'dark'): Colormap {
  const steps = [BLUE[100], BLUE[200], BLUE[300], BLUE[400], BLUE[500], BLUE[600], BLUE[700]];
  // Near-zero anchors to the surface: light end in light mode, dark end in dark.
  const ordered = mode === 'light' ? steps : steps.slice().reverse();
  return makeRamp(ordered.map(lab));
}

// --- Standard scientific colormaps ------------------------------------------
// 33-point tables sampled from matplotlib; dense enough that linear sRGB
// interpolation between stops is indistinguishable from the originals.

function makeSrgbRamp(stops: string[]): Colormap {
  const rgb = stops.map((hex) => {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  });
  return (t: number) => {
    const u = Math.min(1, Math.max(0, t)) * (rgb.length - 1);
    const i = Math.min(rgb.length - 2, Math.floor(u));
    const f = u - i;
    const A = rgb[i];
    const B = rgb[i + 1];
    return [
      Math.round(A[0] + (B[0] - A[0]) * f),
      Math.round(A[1] + (B[1] - A[1]) * f),
      Math.round(A[2] + (B[2] - A[2]) * f),
    ];
  };
}

const STOPS: Record<string, string[]> = {
  viridis: ['#440154','#470d60','#48186a','#482374','#472d7b','#453781','#424086','#3e4989','#3b528b','#375b8d','#33638d','#2f6b8e','#2c728e','#297a8e','#26828e','#23898e','#21918c','#1f988b','#1fa088','#22a785','#28ae80','#32b67a','#3fbc73','#4ec36b','#5ec962','#70cf57','#84d44b','#98d83e','#addc30','#c2df23','#d8e219','#ece51b','#fde725'],
  plasma: ['#0d0887','#220690','#310597','#3f049c','#4c02a1','#5901a5','#6600a7','#7201a8','#7e03a8','#8a09a5','#9511a1','#a01a9c','#aa2395','#b32c8e','#bc3587','#c43e7f','#cc4778','#d35171','#da5a6a','#e06363','#e66c5c','#eb7655','#f0804e','#f58b47','#f89540','#fba139','#fdac33','#feb82c','#fdc527','#fcd225','#f8df25','#f4ed27','#f0f921'],
  inferno: ['#000004','#040312','#0b0724','#150b37','#210c4a','#2f0a5b','#3d0965','#4a0c6b','#57106e','#64156e','#71196e','#7d1e6d','#8a226a','#972766','#a32c61','#b0315b','#bc3754','#c73e4c','#d24644','#db503b','#e45a31','#eb6628','#f1731d','#f68013','#f98e09','#fb9d07','#fcac11','#fbbc21','#f9cb35','#f5db4c','#f2ea69','#f3f68a','#fcffa4'],
  magma: ['#000004','#030312','#0a0822','#130d34','#1d1147','#29115a','#36106b','#440f76','#51127c','#5d177f','#6a1c81','#762181','#832681','#902a81','#9c2e7f','#aa337d','#b73779','#c43c75','#d0416f','#dc4869','#e75263','#ef5d5e','#f56b5c','#f9795d','#fc8961','#fd9869','#fea772','#feb67c','#fec488','#fed395','#fde2a3','#fcf0b2','#fcfdbf'],
  cividis: ['#00224e','#00285b','#002e6a','#053371','#1a386f','#273e6e','#32436d','#3b496c','#434e6c','#4b546c','#535a6d','#5a5f6e','#61656f','#686a71','#6f7073','#767676','#7d7c78','#848279','#8c8878','#938e78','#9b9476','#a39a74','#aba072','#b4a76f','#bcae6c','#c4b468','#cdbb63','#d5c25e','#dec958','#e7d150','#f0d846','#f9e03a','#fee838'],
  coolwarm: ['#3b4cc0','#445acc','#4e68d8','#5875e1','#6282ea','#6c8ff1','#779af7','#82a6fb','#8db0fe','#98b9ff','#a3c2fe','#aec9fc','#b9d0f9','#c3d5f4','#ccd9ed','#d5dbe5','#dddcdc','#e5d8d1','#ecd3c5','#f1ccb8','#f5c4ac','#f7ba9f','#f7b093','#f6a586','#f4987a','#f08b6e','#eb7d62','#e46e56','#dd5f4b','#d44e41','#ca3b37','#be242e','#b40426'],
  rdbu: ['#053061','#0e4179','#175290','#1f63a8','#2a71b2','#3480b9','#3f8ec0','#529dc8','#6bacd1','#84bcd9','#9bc9e0','#aed3e6','#c2ddec','#d4e6f1','#e0ecf3','#ecf2f5','#f7f6f6','#f9eee7','#fbe5d8','#fddcc9','#fbccb4','#f8bb9e','#f5aa89','#ee9677','#e48066','#db6b55','#d05548','#c53e3d','#ba2832','#ab162a','#930e26','#7c0722','#67001f'],
};

/**
 * Reduce a colormap to n discrete colors. The visual payoff: iso-value bands
 * whose edges act as free contour lines of the field.
 */
export function quantize(map: Colormap, n: number): Colormap {
  return (t: number) => {
    const u = Math.min(1, Math.max(0, t));
    const bin = Math.min(n - 1, Math.floor(u * n));
    return map((bin + 0.5) / n);
  };
}

/** Selectable colormaps for the field panels; key order = dropdown order. */
export const COLORMAPS: Record<string, { label: string; map: Colormap }> = {
  turbo: { label: 'Turbo', map: turboMap() },
  viridis: { label: 'Viridis', map: makeSrgbRamp(STOPS.viridis) },
  plasma: { label: 'Plasma', map: makeSrgbRamp(STOPS.plasma) },
  inferno: { label: 'Inferno', map: makeSrgbRamp(STOPS.inferno) },
  magma: { label: 'Magma', map: makeSrgbRamp(STOPS.magma) },
  cividis: { label: 'Cividis', map: makeSrgbRamp(STOPS.cividis) },
  coolwarm: { label: 'Coolwarm', map: makeSrgbRamp(STOPS.coolwarm) },
  rdbu: { label: 'Blue–white–red', map: makeSrgbRamp(STOPS.rdbu) },
};
