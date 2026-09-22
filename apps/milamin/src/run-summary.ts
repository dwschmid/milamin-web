// The run summary box shared by the million and playground pages: the stage
// times as they come in, then a stacked bar of the five stages, the totals,
// and (million page, at the million size only) the comparison with 2008.
// Times are never extrapolated to another problem size.

export const STAGE_LABELS: Record<string, string> = {
  mesh: 'mesh',
  assemble: 'element matrices & assembly',
  factor: 'factorization',
  ph: 'pressure iterations',
  render: 'render',
};

const STAGE_COLORS: Record<string, string> = {
  mesh: '#7f8c8d',
  assemble: '#c8a24a',
  factor: '#b5601f',
  ph: '#3d7ea6',
  render: '#5f8f5a',
};

export interface StageTime {
  key: string;
  ms: number | null; // null = running
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms.toFixed(0)} ms`;
}

export interface RunFacts {
  /** unknowns in 2008 counting (see @fem/unknowns) */
  dofs: number;
  elements: number;
  threadNote: string;
  /** compare with the 2008 claim (one million unknowns in one minute);
   *  only meaningful for the benchmark problem at the million size */
  compare2008?: boolean;
}

export function createRunSummary(root: HTMLElement) {
  root.classList.add('run-summary');
  root.hidden = true;
  root.innerHTML =
    '<div class="run-facts"></div>' +
    '<div class="stage-bar"></div>' +
    '<div class="stats run-stages"></div>' +
    '<div class="run-total"></div>';
  const facts = root.querySelector<HTMLElement>('.run-facts')!;
  const bar = root.querySelector<HTMLElement>('.stage-bar')!;
  const stagesEl = root.querySelector<HTMLElement>('.run-stages')!;
  const totalEl = root.querySelector<HTMLElement>('.run-total')!;

  function renderStages(stages: StageTime[]) {
    stagesEl.innerHTML = stages
      .map(
        (s) =>
          `<span><i style="background:${STAGE_COLORS[s.key]}"></i>${STAGE_LABELS[s.key]}: ` +
          `<b>${s.ms === null ? '…' : fmtMs(s.ms)}</b></span>`,
      )
      .join('');
  }

  return {
    /** a run starts: box visible, everything cleared */
    start() {
      root.hidden = false;
      facts.textContent = '';
      bar.innerHTML = '';
      bar.hidden = true;
      stagesEl.textContent = '';
      totalEl.textContent = '';
    },
    stages: renderStages,
    /** the run is complete: bar, totals, comparison */
    finish(stages: StageTime[], f: RunFacts) {
      renderStages(stages);
      const totalMs = stages.reduce((a, s) => a + (s.ms ?? 0), 0);
      bar.innerHTML = stages
        .map(
          (s) =>
            `<i style="flex:${(s.ms ?? 0) / totalMs};background:${STAGE_COLORS[s.key]}" ` +
            `title="${STAGE_LABELS[s.key]}: ${fmtMs(s.ms ?? 0)}"></i>`,
        )
        .join('');
      bar.hidden = false;
      facts.innerHTML =
        `<b>${f.dofs.toLocaleString('en')}</b> unknowns, ` +
        `<b>${f.elements.toLocaleString('en')}</b> elements, ${f.threadNote}`;
      let html = `<b>${(totalMs / 1000).toFixed(1)} s</b><span>the five stages, in total</span>`;
      // Compare the same timed stages as Table 2, without extrapolating size.
      const referenceStages = ['assemble', 'factor', 'ph'].map(key => stages.find(s => s.key === key)?.ms);
      if (f.compare2008 && f.dofs > 0.8e6 && f.dofs < 1.2e6 &&
          referenceStages.every(ms => typeof ms === 'number' && Number.isFinite(ms))) {
        const assemblySolve = referenceStages.reduce<number>((sum, ms) => sum + ms!, 0);
        if (assemblySolve > 0) html +=
          `<b>${(49_000 / assemblySolve).toFixed(1)}×</b><span>2008 reference time / this run's assembly + solution time ` +
          `(${fmtMs(assemblySolve)}). Table 2: 49 s at one million unknowns; geometry and hardware differ.</span>`;
      }
      totalEl.innerHTML = html;
    },
  };
}
