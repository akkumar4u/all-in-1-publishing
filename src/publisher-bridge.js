// Bridge messages from the local Auto Publishing interface into the extension.
// It does not expose any WordPress session data to the page.
window.addEventListener('message', event => {
  if (event.source !== window) return;

  const message = event.data;
  if (message?.source !== 'autopublishing-app' || message?.type !== 'QUEUE_WORDPRESS_DRAFT') return;

  chrome.runtime.sendMessage({ type: 'QUEUE_WORDPRESS_DRAFT', draft: message.draft });
});
