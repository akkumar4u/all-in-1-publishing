/* "Time log" box at the bottom of the popup: how long each stage of the last run took.
 * Reads what the background scripts saved in chrome.storage.local and updates live while a run is going. */
(function () {
  const body = document.getElementById('time-log-body');
  const sumEl = document.getElementById('time-log-sum');
  const copyBtn = document.getElementById('time-log-copy');
  if (!body) return;

  const KEYS = ['timeLogAuto', 'timeLogSalesforce', 'timeLogImport', 'diLandingImage', 'diBlogImage', 'timeLog'];
  const fmt = s => Number(s).toFixed(1) + 's';
  const clock = ms => ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

  // turn what is stored into a list of { title, at, total, steps:[{label,s}] }, in the order the work happens
  function stages(data) {
    const out = [];
    const auto = data.timeLogAuto;
    if (auto && auto.steps) out.push({ title: auto.source || 'Whole task', at: auto.at, total: auto.total, steps: auto.steps });
    const sf = data.timeLogSalesforce;
    if (sf && sf.steps) out.push({ title: 'Salesforce lookup', at: sf.at, total: sf.total, steps: sf.steps });
    const imp = data.timeLogImport;
    if (imp && imp.steps) out.push({ title: 'Google Doc import', at: imp.at, total: imp.total, steps: imp.steps });
    for (const [key, name] of [['diLandingImage', 'Image Library (Landing / Comparison)'], ['diBlogImage', 'Image Library (Blog)']]) {
      const im = data[key];
      if (im && im.status === 'done' && typeof im.seconds === 'number') {
        const steps = typeof im.scanSeconds === 'number' && im.scanSeconds > 0
          ? [{ label: 'Search the library', s: im.scanSeconds }, { label: 'Download the chosen image' + (im.imageTitle ? ' — ' + im.imageTitle : ''), s: im.seconds }]
          : [{ label: 'Find + download the image' + (im.imageTitle ? ' — ' + im.imageTitle : ''), s: im.seconds }];
        out.push({ title: name, at: im.updatedAt, total: steps.reduce((t, x) => t + x.s, 0), steps });
      }
    }
    const wp = data.timeLog;
    if (wp && wp.steps) out.push({ title: 'WordPress fill — ' + (wp.source || ''), at: wp.at, total: wp.total, steps: wp.steps });
    return out;
  }

  function render(data) {
    const list = stages(data);
    body.replaceChildren();
    if (!list.length) {
      body.textContent = 'No run yet — start a lookup, import or fill and the seconds for every step appear here.';
      sumEl.textContent = '';
      return list;
    }
    let sum = 0;
    for (const st of list) {
      sum += Number(st.total) || 0;
      const box = document.createElement('div');
      box.className = 'tl-stage';
      const head = document.createElement('div');
      head.className = 'tl-head';
      const name = document.createElement('strong');
      name.textContent = st.title;
      const tot = document.createElement('span');
      tot.textContent = fmt(st.total) + (st.at ? '  ·  ' + clock(st.at) : '');
      head.append(name, tot);
      box.append(head);
      const max = Math.max(0.1, ...st.steps.map(x => x.s));
      const slow = [...st.steps].sort((a, b) => b.s - a.s).slice(0, 3).filter(x => x.s >= 1).map(x => x.label);
      for (const step of st.steps) {
        const row = document.createElement('div');
        row.className = 'tl-row' + (slow.includes(step.label) ? ' tl-slow' : '');
        const lab = document.createElement('span');
        lab.className = 'tl-label';
        lab.textContent = step.label;
        const bar = document.createElement('span');
        bar.className = 'tl-bar';
        const fill = document.createElement('i');
        fill.style.width = Math.max(2, Math.round((step.s / max) * 100)) + '%';
        bar.append(fill);
        const sec = document.createElement('span');
        sec.className = 'tl-sec';
        sec.textContent = fmt(step.s);
        row.append(lab, bar, sec);
        box.append(row);
      }
      body.append(box);
    }
    const stageSum = list.filter(x => !/^Whole task/.test(x.title)).reduce((t, x) => t + (Number(x.total) || 0), 0);
    sumEl.textContent = '· ' + fmt(stageSum) + ' of work in the latest run of each stage';
    return list;
  }

  let current = [];
  const refresh = () => chrome.storage.local.get(KEYS).then(d => { current = render(d); });
  refresh();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && KEYS.some(k => changes[k])) refresh();
  });

  copyBtn.addEventListener('click', async () => {
    const text = current.map(st => `${st.title} — ${fmt(st.total)}\n` + st.steps.map(x => `  ${fmt(x.s).padStart(6)}  ${x.label}`).join('\n')).join('\n\n') || 'No run yet.';
    try { await navigator.clipboard.writeText(text); copyBtn.textContent = 'Copied ✓'; }
    catch (e) { copyBtn.textContent = 'Copy failed'; }
    setTimeout(() => { copyBtn.textContent = 'Copy time log'; }, 1500);
  });
})();
