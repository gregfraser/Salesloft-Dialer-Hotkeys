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
  const p = await open({ pageOverlay: true }, { inCall: true });
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
  const p = await open({ pageOverlay: true }, { inCall: true, downshiftMenu: true });
  await act(p, 'kill-and-log');
  await p.waitForTimeout(2000);
  eq('kill-and-log finds the option in a menu that was always rendered', await acted(p),
     ['End Call', 'disposition=No Answer', 'Log & Complete']);
  const s = await statusText(p);
  check('and says it logged', s.includes('Logged No Answer'), 'status was: ' + s);
  await p.close();
}
{
  // The read-back now looks past the toggle to the field around it. It must
  // still refuse a pick that did not take, or the call logs with no disposition.
  const p = await open({ pageOverlay: true },
                       { inCall: true, downshiftMenu: true, dispositionSticks: false });
  await act(p, 'kill-and-log');
  await p.waitForTimeout(10000);
  eq('a pick that does not take in that field still stops before logging', await acted(p),
     ['End Call', 'disposition=No Answer']);
  const s = await statusText(p);
  check('and says why', s.startsWith('Stopped:') && s.includes('did not take'), 'status was: ' + s);
  await p.close();
}
{
  // "Call" has to be found by its exact visible text, and the mock's other
  // buttons must not satisfy that.
  const p = await open({ pageOverlay: true }, {});
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
  const p = await open({ pageOverlay: true }, {});
  await act(p, 'kill-and-log');
  await p.waitForTimeout(300);
  // The pair must still be gated while a flow runs.
  const busy = await p.evaluate(() => document.getElementById('sl-hotkey-overlay').classList.contains('sl-busy'));
  check('the busy class still lands on the plate', busy);
  await p.close();
}

console.log('\nWhere the plate is allowed to be');
{
  // The cadence People list: the logger popout is open over it, but nothing
  // has been dialled. A dialer plate has no business beside 170 rows.
  const p = await open({ pageOverlay: true }, { listPage: true });
  check('a list page with an open popout gets no plate',
        (await p.$('#sl-hotkey-overlay')) === null);
  await p.close();
}
{
  // Same page, but the call is up. Taking the buttons away mid-call is the one
  // outcome worse than showing them early.
  const p = await open({ pageOverlay: true }, { listPage: true });
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
  const p = await open({ pageOverlay: true }, {});
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
  const p = await open({ pageOverlay: true }, {});
  eq('the full plate is what you get by default', await plate(p), { w: 236, h: 160 });
  await p.close();
}
{
  const p = await open({ pageOverlay: true, compactBar: true }, {});
  eq('compact is a 214 bar, the width of the column it replaces', await plate(p), { w: 214, h: 44 });
  check('both actions are on it, and they still answer', (await p.$$('#sl-hotkey-overlay .sl-act')).length === 2);
  await p.close();
}
{
  const p = await open({ pageOverlay: true, compactBar: true }, {});
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
  // An older install shipped a third action on the up arrow, and bindings are
  // synced. That key must now do nothing at all, on either surface, and give
  // the page its scrolling back.
  const p = await open({ pageOverlay: true,
                         hotkeys: { 'kill-and-log': 'ArrowLeft', 'start-call': 'ArrowRight',
                                    'not-in-service': 'ArrowUp' } }, { inCall: true });
  const prevented = await p.evaluate(() => {
    const e = new KeyboardEvent('keydown', { code: 'ArrowUp', key: 'ArrowUp', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    return e.defaultPrevented;
  });
  await p.waitForTimeout(400);
  eq('a leftover up-arrow binding takes no action', await acted(p), []);
  check('and does not swallow the key', !prevented);
  check('and no third control is drawn', (await p.$('#sl-hotkey-overlay .sl-second')) === null);
  await p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) console.log('failures:\n  ' + errs.join('\n  '));
await browser.close();
process.exit(fail ? 1 : 0);
