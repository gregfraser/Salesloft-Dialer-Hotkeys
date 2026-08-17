// Floating panel — buttons relay through the background worker to the
// Salesloft tab; status updates stream back from the content script.

const statusEl = document.getElementById('status');

function send(action) {
  chrome.runtime.sendMessage({ type: 'dialer-action', action }).catch(() => {
    setStatus('Background not reachable — reload extension', 'err');
  });
}

document.getElementById('kill').addEventListener('click', () => send('kill-and-log'));
document.getElementById('call').addEventListener('click', () => send('start-call'));

function setStatus(msg, kind) {
  statusEl.textContent = msg;
  statusEl.className = kind || '';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') setStatus(msg.msg, msg.kind);
});
