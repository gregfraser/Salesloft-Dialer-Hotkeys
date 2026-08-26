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

// Contact alerts mirrored from the Salesloft page, colour-coded the same way:
// blue for a booked meeting, red for a hard no, green for interest.
const alertEl = document.getElementById('alert');

function renderAlert({ tags = [], name = '', color = 'amber' }) {
  if (!tags.length) {
    alertEl.className = '';
    alertEl.textContent = '';
    return;
  }
  const theme = SL_PALETTE[color] || SL_PALETTE.amber;
  alertEl.style.background = theme.bg;
  alertEl.style.borderColor = theme.border;
  alertEl.textContent = '';

  const who = document.createElement('div');
  who.className = 'who';
  who.style.color = theme.text;
  who.textContent = name ? `${name} — ${SL_HEADLINE[color]}` : SL_HEADLINE[color];

  const list = document.createElement('div');
  list.className = 'tags';
  for (const tag of tags) {
    const tagTheme = SL_PALETTE[slColorFor(tag)] || SL_PALETTE.amber;
    const chip = document.createElement('span');
    chip.className = 'tag';
    chip.textContent = tag;
    chip.style.background = tagTheme.bg;
    chip.style.borderColor = tagTheme.border;
    chip.style.color = tagTheme.text;
    list.appendChild(chip);
  }

  alertEl.appendChild(who);
  alertEl.appendChild(list);
  alertEl.className = 'show';
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'status') setStatus(msg.msg, msg.kind);
  if (msg.type === 'contact-alert') renderAlert(msg);
});
