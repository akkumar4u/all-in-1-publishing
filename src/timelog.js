/**
 * Tiny stopwatch used by the background scripts. Each stage of the work (Salesforce lookup, Google Doc
 * import, ...) keeps its own list of steps in chrome.storage.local, and the popup's "Time log" box shows them.
 *
 *   const TL = startTimeLog('timeLogSalesforce', 'Salesforce lookup');
 *   ... step finished ...   TL.lap('Open helper window');   // seconds since the previous lap
 *   TL.save();                                               // writes the total
 *
 * Same shape the WordPress fill already uses: { source, at, total, steps: [{ label, s }] }.
 * It never throws, so it can never break a run.
 */
export function startTimeLog(key, source) {
  const t0 = Date.now();
  let last = t0;
  const steps = [];
  const r1 = ms => Math.round(ms / 100) / 10;
  const save = () => {
    try {
      return chrome.storage.local.set({ [key]: { source, at: Date.now(), total: r1(Date.now() - t0), steps } }).catch(() => {});
    } catch (e) { return Promise.resolve(); }
  };
  save();   // clears the previous run's numbers straight away
  return {
    lap(label) {
      const now = Date.now();
      steps.push({ label, s: r1(now - last) });
      last = now;
      return save();
    },
    save,
  };
}
