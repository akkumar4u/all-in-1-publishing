// Opens each tool's own, unmodified popup UI (hub_popup.html / blog_popup.html)
// as a standalone extension window. Both keep working exactly as before —
// this file only launches them, it doesn't touch their logic.
function openTool(page, title) {
  chrome.windows.create({
    url: chrome.runtime.getURL(page),
    type: 'popup',
    width: 440,
    height: 680,
    focused: true,
  });
  window.close();
}

document.querySelector('#open-hub').addEventListener('click', () => {
  openTool('hub_popup.html', 'Hub Publisher');
});

document.querySelector('#open-blog').addEventListener('click', () => {
  openTool('blog_popup.html', 'Auto Publishing');
});
