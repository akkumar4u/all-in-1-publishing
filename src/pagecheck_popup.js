/* "Page check" box in the popup: the result of the automatic, read-only check the extension runs on the
 * WordPress page right after filling it (title, slug, template, parent, Yoast, rows, text, image).
 * Problems are listed first; the box opens by itself when something needs attention. */
(function () {
  const box = document.getElementById('page-check');
  const body = document.getElementById('page-check-body');
  const sum = document.getElementById('page-check-sum');
  if (!box || !body) return;
  const clock = ms => ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';

  function render(report) {
    body.replaceChildren();
    if (!report || !Array.isArray(report.checks) || !report.checks.length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    const bad = report.checks.filter(c => !c.ok);
    sum.textContent = bad.length
      ? `${bad.length} need${bad.length === 1 ? 's' : ''} attention (of ${report.checks.length})`
      : `all ${report.checks.length} OK`;
    box.classList.toggle('pc-bad', bad.length > 0);
    box.classList.toggle('pc-good', bad.length === 0);
    if (bad.length) box.open = true;
    const head = document.createElement('div');
    head.className = 'pc-title';
    head.textContent = (report.title || 'Page') + (report.at ? '  ·  checked ' + clock(report.at) : '');
    body.append(head);
    for (const c of [...bad, ...report.checks.filter(x => x.ok)]) {
      const row = document.createElement('div');
      row.className = 'pc-row ' + (c.ok ? 'pc-ok' : 'pc-no');
      const mark = document.createElement('span');
      mark.className = 'pc-mark';
      mark.textContent = c.ok ? '✓' : '✗';
      const name = document.createElement('strong');
      name.textContent = c.name;
      const detail = document.createElement('span');
      detail.className = 'pc-detail';
      detail.textContent = c.detail || '';
      row.append(mark, name, detail);
      body.append(row);
    }
  }

  chrome.storage.local.get('pageCheck').then(d => render(d.pageCheck));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.pageCheck) render(changes.pageCheck.newValue);
  });
})();
