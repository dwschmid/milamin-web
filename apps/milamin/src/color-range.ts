// Colour-range control shared by the million and playground pages: a select
// (automatic / set below) and min-max inputs for pressure and shear stress.
// In automatic mode the inputs mirror the computed limits, so switching to
// manual starts from what is on screen.
import type { FieldRange } from '@viz/render';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export function initColorRange(onChange: () => void) {
  const sel = $<HTMLSelectElement>('in-crange');
  const ins = {
    pMin: $<HTMLInputElement>('in-pmin'),
    pMax: $<HTMLInputElement>('in-pmax'),
    tauMin: $<HTMLInputElement>('in-tmin'),
    tauMax: $<HTMLInputElement>('in-tmax'),
  };
  const rows = document.querySelectorAll<HTMLElement>('[data-crange]');
  const showRows = () => {
    for (const r of rows) r.style.display = sel.value === 'manual' ? '' : 'none';
  };
  showRows();
  sel.addEventListener('change', () => {
    showRows();
    onChange();
  });
  for (const el of Object.values(ins)) el.addEventListener('input', () => sel.value === 'manual' && onChange());

  const fmt = (v: number) => String(Number(v.toPrecision(3)));
  return {
    /** the range to draw with: the user's limits when set and valid, else the automatic ones */
    apply(auto: FieldRange): FieldRange {
      if (sel.value === 'manual') {
        const v = {
          pMin: Number(ins.pMin.value),
          pMax: Number(ins.pMax.value),
          tauMin: Number(ins.tauMin.value),
          tauMax: Number(ins.tauMax.value),
        };
        const ok = Object.values(v).every(Number.isFinite) && v.pMax > v.pMin && v.tauMax > v.tauMin;
        if (ok) return v;
      }
      ins.pMin.value = fmt(auto.pMin);
      ins.pMax.value = fmt(auto.pMax);
      ins.tauMin.value = fmt(auto.tauMin);
      ins.tauMax.value = fmt(auto.tauMax);
      return auto;
    },
  };
}
