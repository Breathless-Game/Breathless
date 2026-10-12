// The offline page's Retry: go back to the site main.js loaded us for. main.js only lets the
// window navigate to that origin, so a tampered ?url= gets nowhere.
'use strict';

const params = new URLSearchParams(location.search);
const reason = params.get('reason');
if (reason) document.getElementById('reason').textContent = reason;

function siteUrl() {
  try {
    const url = new URL(params.get('url') || '');
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {
    // fall through
  }
  return 'https://breathless.gotclass.xyz/';
}

const button = document.getElementById('retry');
function retry() {
  button.disabled = true;
  location.href = siteUrl();
}
button.addEventListener('click', retry);
// Back online: try again by itself.
window.addEventListener('online', retry);
