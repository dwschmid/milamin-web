// Shared pan/zoom for the field panels: wheel zooms about the cursor, drag
// pans, double-click resets, and +/-/1:1 buttons inside the same .panel serve
// devices without a wheel. The caller owns the extent object (mutated in
// place) and redraws via the callback: settled=false during a gesture (draw a
// cheap preview), settled=true ~180 ms after the last gesture (full quality).

export interface ViewRect {
  cx: number;
  cy: number;
  halfWidth: number;
}

export function attachPanZoom(
  canvases: HTMLCanvasElement[],
  ext: ViewRect,
  home: () => ViewRect,
  onChange: (settled: boolean) => void,
  opts?: { maxOut?: number; minHalfWidth?: number },
): void {
  const maxOut = opts?.maxOut ?? 1; // allowed zoom-out factor beyond home
  const minHW = opts?.minHalfWidth ?? 0.02;
  let settleTimer: number | undefined;
  let raf = false;

  function changed() {
    if (!raf) {
      raf = true;
      requestAnimationFrame(() => {
        raf = false;
        onChange(false);
      });
    }
    window.clearTimeout(settleTimer);
    settleTimer = window.setTimeout(() => onChange(true), 180);
  }

  function clampHW(hw: number): number {
    return Math.min(home().halfWidth * maxOut, Math.max(minHW, hw));
  }

  function zoomAt(wx: number, wy: number, f: number) {
    const hw = clampHW(ext.halfWidth * f);
    const s = hw / ext.halfWidth;
    ext.cx = wx - (wx - ext.cx) * s;
    ext.cy = wy - (wy - ext.cy) * s;
    ext.halfWidth = hw;
    if (hw >= home().halfWidth * maxOut - 1e-12 && maxOut === 1) {
      const h = home();
      ext.cx = h.cx;
      ext.cy = h.cy;
    }
    changed();
  }

  function reset() {
    Object.assign(ext, home());
    changed();
  }

  for (const canvas of canvases) {
    const toWorld = (ev: { clientX: number; clientY: number }): [number, number] => {
      const r = canvas.getBoundingClientRect();
      return [
        ext.cx + ((ev.clientX - r.left) / r.width - 0.5) * 2 * ext.halfWidth,
        ext.cy + (0.5 - (ev.clientY - r.top) / r.height) * 2 * ext.halfWidth,
      ];
    };

    canvas.addEventListener(
      'wheel',
      (ev) => {
        ev.preventDefault();
        const [wx, wy] = toWorld(ev);
        zoomAt(wx, wy, ev.deltaY > 0 ? 1.18 : 1 / 1.18);
      },
      { passive: false },
    );

    let panStart: { px: number; py: number; cx: number; cy: number } | null = null;
    canvas.addEventListener('pointerdown', (ev) => {
      panStart = { px: ev.clientX, py: ev.clientY, cx: ext.cx, cy: ext.cy };
      canvas.setPointerCapture(ev.pointerId);
    });
    canvas.addEventListener('pointerup', (ev) => {
      panStart = null;
      canvas.releasePointerCapture(ev.pointerId);
    });
    canvas.addEventListener('pointermove', (ev) => {
      if (!panStart || ev.buttons !== 1) return;
      const r = canvas.getBoundingClientRect();
      const wpp = (2 * ext.halfWidth) / r.width;
      ext.cx = panStart.cx - (ev.clientX - panStart.px) * wpp;
      ext.cy = panStart.cy + (ev.clientY - panStart.py) * wpp;
      changed();
    });
    canvas.addEventListener('dblclick', reset);

    // panel-scoped buttons
    const panel = canvas.closest('.panel');
    if (panel) {
      panel.querySelector('.zoom-in')?.addEventListener('click', () => zoomAt(ext.cx, ext.cy, 1 / 1.5));
      panel.querySelector('.zoom-out')?.addEventListener('click', () => zoomAt(ext.cx, ext.cy, 1.5));
      panel.querySelector('.zoom-reset')?.addEventListener('click', reset);
    }
  }
}
