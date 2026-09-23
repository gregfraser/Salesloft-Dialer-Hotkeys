import { chromium } from 'playwright';
// CHROMIUM_PATH is for a machine where Playwright's own download is not
// where it expects; normally Playwright finds its browser itself.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const HERE = import.meta.dirname;
let pass = 0, fail = 0; const errs = [];
const check = (n, ok, d) => ok ? (pass++, console.log('  ok   ' + n))
  : (fail++, errs.push(n), console.log('  FAIL ' + n + (d ? '\n         ' + d : '')));
const eq = (n, a, e) => check(n, JSON.stringify(a) === JSON.stringify(e),
  `expected ${JSON.stringify(e)}\n         actual   ${JSON.stringify(a)}`);

async function open(settings, mockOpts) {
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
  page.on('pageerror', (e) => { fail++; errs.push('pageerror: ' + e.message); console.log('  PAGE ERROR: ' + e.message); });
  await page.addInitScript((s) => { window.__slSettings = s; window.__slCommandKeys = {}; }, settings);
  await page.goto('file://' + HERE + '/mock.html');
  await page.waitForTimeout(250);
  if (mockOpts) {
    await page.evaluate((o) => window.__buildSalesloft(o), mockOpts);
    // syncOverlay() rides a 250ms debounce behind the MutationObserver, so a
    // rebuilt page needs longer than a frame before it has settled.
    await page.waitForTimeout(500);
  }
  return page;
}
const acted = (p) => p.evaluate(() => window.__acted);
const statusText = (p) => p.evaluate(() => {
  const b = document.getElementById('sl-hotkey-overlay');
  const s = b && b.querySelector('.sl-status');
  return s ? s.textContent : null;
});
const act = (p, action) => p.evaluate((a) =>
  window.__slOnMessage({ type: 'dialer-action', action: a }, null, () => {}), action);

console.log('\nThe two flows I did not touch');
{
  const p = await open({ pageOverlay: true, notInService: true }, { inCall: true });
  await act(p, 'kill-and-log');
  await p.waitForTimeout(2000);
  eq('kill-and-log still ends, dispositions and completes', await acted(p),
     ['End Call', 'disposition=No Answer', 'Log & Complete']);
  const s = await statusText(p);
  check('and still says it logged', s.includes('Logged No Answer'), 'status was: ' + s);
  await p.close();
}
{
  // The bug from the field: Downshift's menu is in the DOM before it opens, so
  // counting it among the lists that were "already there" ruled out the very
  // list the toggle opened.
  const p = await open({ pageOverlay: true, notInService: true }, { inCall: true, downshiftMenu: true });
  await act(p, 'kill-and-log');
  await p.waitForTimeout(2000);
  eq('kill-and-log finds the option in a menu that was always rendered', await acted(p),
     ['End Call', 'disposition=No Answer', 'Log & Complete']);
  const s = await statusText(p);
  check('and says it logged', s.includes('Logged No Answer'), 'status was: ' + s);
  await p.close();
}
{
  // "Call" has to be found by its exact visible text, and the mock's other
  // buttons must not satisfy that.
  const p = await open({ pageOverlay: true, notInService: true }, {});
  await p.evaluate(() => {
    const b = document.createElement('button');
    b.textContent = 'Call';
    b.addEventListener('click', () => window.__acted.push('Call'));
    document.getElementById('app').appendChild(b);
  });
  await act(p, 'start-call');
  await p.waitForTimeout(600);
  eq('start-call still dials', await acted(p), ['Call']);
  await p.close();
}
{
  const p = await open({ pageOverlay: true, notInService: true }, {});
  await act(p, 'kill-and-log');
  await p.waitForTimeout(300);
  // The pair must still be gated while a flow runs.
  const busy = await p.evaluate(() => document.getElementById('sl-hotkey-overlay').classList.contains('sl-busy'));
  check('the busy class still lands on the plate', busy);
  await p.close();
}

console.log('\nToggling the setting live');
{
  const p = await open({ pageOverlay: true, notInService: false }, {});
  check('starts with no strip', (await p.$('#sl-hotkey-overlay .sl-second')) === null);
  await p.evaluate(() => window.__slOnStorage({ notInService: { newValue: true } }, 'sync'));
  await p.waitForTimeout(300);
  check('turning it on rebuilds the plate with the strip', (await p.$('#sl-hotkey-overlay .sl-second')) !== null);
  const pair = await p.evaluate(() => [...document.querySelectorAll('#sl-hotkey-overlay .sl-act')]
    .map((b) => Math.round(b.getBoundingClientRect().width)));
  eq('and the pair is still equal and unchanged', pair, [104, 104]);
  await p.evaluate(() => window.__slOnStorage({ notInService: { newValue: false } }, 'sync'));
  await p.waitForTimeout(300);
  check('turning it off takes it away again', (await p.$('#sl-hotkey-overlay .sl-second')) === null);
  await p.close();
}
{
  // Arming, then losing the control to a rebuild, must not leave a press made.
  const p = await open({ pageOverlay: true, notInService: true }, {});
  await p.click('#sl-hotkey-overlay .sl-second');
  await p.waitForTimeout(150);
  await p.evaluate(() => window.__slOnStorage({ transcription: { newValue: true } }, 'sync'));
  await p.waitForTimeout(300);
  const label = await p.textContent('#sl-hotkey-overlay .sl-second .sl-second-label');
  check('a rebuild mid-arm disarms rather than carrying the press over', label === 'Not in Service',
        'label was: ' + label);
  await p.click('#sl-hotkey-overlay .sl-second');
  await p.waitForTimeout(800);
  eq('so the next press arms rather than committing', await acted(p), []);
  await p.close();
}

console.log('\nWhere the plate is allowed to be');
{
  // The cadence People list: the logger popout is open over it, but nothing
  // has been dialled. A dialer plate has no business beside 170 rows.
  const p = await open({ pageOverlay: true, notInService: true }, { listPage: true });
  check('a list page with an open popout gets no plate',
        (await p.$('#sl-hotkey-overlay')) === null);
  await p.close();
}
{
  // Same page, but the call is up. Taking the buttons away mid-call is the one
  // outcome worse than showing them early.
  const p = await open({ pageOverlay: true, notInService: true }, { listPage: true });
  await p.evaluate(() => { window.__slCallState = 'IN_CALL'; });
  await p.evaluate(() => {
    // call-detect reports through the same path a real detection would.
    const el = document.createElement('button');
    el.setAttribute('aria-label', 'End Call');
    el.textContent = 'End Call';
    document.getElementById('app').appendChild(el);
  });
  await p.waitForTimeout(1200);
  check('once a call is up, the plate comes back on that same page',
        (await p.$('#sl-hotkey-overlay')) !== null);
  await p.close();
}
{
  const p = await open({ pageOverlay: true, notInService: true }, {});
  check('a contact view still gets the plate with no call at all',
        (await p.$('#sl-hotkey-overlay')) !== null);
  await p.close();
}

console.log('\nThe compact bar');
const plate = (p) => p.evaluate(() => {
  const b = document.getElementById('sl-hotkey-overlay');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { w: Math.round(r.width), h: Math.round(r.height) };
});
{
  const p = await open({ pageOverlay: true, notInService: true }, {});
  eq('the full plate is what you get by default', await plate(p), { w: 236, h: 160 });
  check('and the third control is on it', (await p.$('#sl-hotkey-overlay .sl-second')) !== null);
  await p.close();
}
{
  const p = await open({ pageOverlay: true, compactBar: true, notInService: true }, {});
  eq('compact is a 214 bar, the width of the column it replaces', await plate(p), { w: 214, h: 44 });
  check('no strip on it — that control is not for this surface',
        (await p.$('#sl-hotkey-overlay .sl-second')) === null);
  check('but both actions are, and they still answer', (await p.$$('#sl-hotkey-overlay .sl-act')).length === 2);
  await p.close();
}
{
  const p = await open({ pageOverlay: true, compactBar: true, notInService: true }, {});
  await p.evaluate(() => {
    const el = document.createElement('button');
    el.setAttribute('aria-label', 'End Call');
    el.textContent = 'End Call';
    document.getElementById('app').appendChild(el);
  });
  await p.waitForTimeout(900);
  eq('a live call opens it to the full plate', await plate(p), { w: 236, h: 160 });
  await p.evaluate(() => [...document.querySelectorAll('button')]
    .find((b) => b.textContent === 'End Call').remove());
  await p.waitForTimeout(900);
  eq('and it closes again when the call ends', await plate(p), { w: 214, h: 44 });
  await p.close();
}
{
  const p = await open({ pageOverlay: false, compactBar: true }, {});
  check('compact means nothing with the page controls off',
        (await p.$('#sl-hotkey-overlay')) === null);
  await p.close();
}
{
  // The shipped key is an arrow now, and the compact bar has no strip to arm.
  // Refusing has to say something true on that surface, not "turn the on-page
  // buttons on" to a rep who already has.
  const p = await open({ pageOverlay: true, compactBar: true, notInService: true,
                         hotkeys: { 'kill-and-log': 'ArrowLeft', 'start-call': 'ArrowRight',
                                    'not-in-service': 'ArrowUp' } }, {});
  await p.keyboard.press('ArrowUp');
  await p.waitForTimeout(400);
  const s = await statusText(p);
  check('the key refuses on the compact bar and says why', s.includes('full plate'), 'status was: ' + s);
  eq('and takes no action', await acted(p), []);
  await p.close();
}
{
  const p = await open({ pageOverlay: true, notInService: true }, {});
  await p.keyboard.press('ArrowUp');
  await p.waitForTimeout(400);
  check('the shipped arrow arms on the full plate',
        (await p.textContent('#sl-hotkey-overlay .sl-second .sl-second-label')) === 'Remove from cadence?');
  await p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('failures:\n  ' + errs.join('\n  '));
await browser.close();
process.exit(fail ? 1 : 0);
