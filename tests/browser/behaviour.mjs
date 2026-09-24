import { chromium } from 'playwright';

// CHROMIUM_PATH is for a machine where Playwright's own download is not
// where it expects; normally Playwright finds its browser itself.
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}
);
const HERE = import.meta.dirname;
let pass = 0, fail = 0;
const errors = [];

function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n         ' + detail : '')); errors.push(name); }
}
const eq = (name, actual, expected) =>
  check(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);

async function open(settings, mockOpts) {
  const page = await browser.newPage({ viewport: { width: 900, height: 500 } });
  page.on('pageerror', (e) => { fail++; errors.push('pageerror: ' + e.message); console.log('  PAGE ERROR: ' + e.message); });
  await page.addInitScript((s) => {
    window.__slSettings = s;
    window.__slCommandKeys = {};
  }, settings);
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

const ON = { pageOverlay: true, notInService: true, transcription: false };
const strip = '#sl-hotkey-overlay .sl-second';
const acted = (p) => p.evaluate(() => window.__acted);
const status = (p) => p.textContent('#sl-hotkey-overlay [style*="text-overflow"]').catch(() => null);
const statusText = (p) => p.evaluate(() => {
  const box = document.getElementById('sl-hotkey-overlay');
  const s = box && box.querySelector('.sl-status');
  return s ? s.textContent : null;
});

// ---------------------------------------------------------------- the flow
console.log('\nNot in Service — the flow');
{
  const p = await open(ON, { inCall: true, confirm: false });
  await p.click(strip);
  await p.waitForTimeout(300);
  eq('one press arms and touches nothing', await acted(p), []);
  check('the label becomes the question', (await p.textContent(strip + ' .sl-second-label')) === 'Remove from cadence?');

  const t0 = Date.now();
  await p.click(strip);
  await p.waitForTimeout(4000);
  console.log(`       (a full run with no dialog takes ~${Math.round((Date.now() - t0) / 100) / 10}s of wall clock)`);
  eq('two presses run every step in order', await acted(p),
     ['End Call', 'disposition=Not in Service', 'menu opened', 'Log Only', 'remove from cadence']);
  check('it reports the removal', (await statusText(p)).includes('removed from cadence'),
        'status was: ' + await statusText(p));
  check('it disarms afterwards', (await p.textContent(strip + ' .sl-second-label')) === 'Not in Service');
  await p.close();
}

{
  const p = await open(ON, {});
  await p.click(strip); await p.waitForTimeout(3300);
  check('arming lapses on its own', (await p.textContent(strip + ' .sl-second-label')) === 'Not in Service');
  await p.click(strip); await p.waitForTimeout(800);
  eq('a press after the lapse re-arms rather than committing', await acted(p), []);
  await p.close();
}

{
  const p = await open({ ...ON, notInServiceDisposition: 'Bad Number' },
                       { dispositions: ['No Answer', 'Bad Number'] });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(2500);
  eq('it uses its own disposition, not the No Answer one', (await acted(p))[0], 'disposition=Bad Number');
  await p.close();
}

// ------------------------------------------------------------- the dialog
console.log('\nThe confirmation dialog');
{
  const p = await open(ON, { confirm: true });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(3000);
  eq('a dialog that appears is confirmed', (await acted(p)).slice(-3),
     ['remove from cadence', 'dialog opened', 'dialog:Remove']);
  await p.close();
}
{
  const p = await open(ON, { confirm: true, confirmButtons: ['Cancel', 'Proceed anyway'] });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  const s = await statusText(p);
  check('an unrecognised dialog stops rather than being left open',
        s.startsWith('Stopped:') && s.includes('removal dialog'), 'status was: ' + s);
  await p.close();
}
{
  const p = await open(ON, { confirm: false });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(3500);
  const s = await statusText(p);
  check('no dialog at all is a normal outcome', s.includes('removed from cadence'), 'status was: ' + s);
  await p.close();
}

console.log('\nThe page as a real contact has it');
{
  // The bug from the field: the feed is full of "Not in Service" pills, and a
  // document-wide `ul li` search clicked one of those instead of the option.
  const p = await open(ON, {});
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  const a = await acted(p);
  check('no decoy on the page is ever clicked', !a.some((x) => x.startsWith('DECOY')), a.join(' | '));
  eq('the disposition comes from the list the toggle opened', a[0], 'disposition=Not in Service');
  check('and the removal still happens', a.includes('remove from cadence'), a.join(' | '));
  await p.close();
}
{
  // A click that lands but does not take. Logging anyway is the thing the
  // invariant forbids, so the flow has to stop here.
  const p = await open(ON, { dispositionSticks: false });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(11000);
  const a = await acted(p);
  const s = await statusText(p);
  check('a disposition that does not take stops the flow', s.startsWith('Stopped:') && s.includes('did not take'),
        'status was: ' + s);
  check('and nothing is logged or removed', !a.includes('Log Only') && !a.includes('remove from cadence'),
        a.join(' | '));
  await p.close();
}

console.log('\nThe dialog, as a real one is built');
{
  // position:fixed, which is what every modal is — and what offsetParent
  // reports as hidden.
  const p = await open(ON, { confirm: true });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  eq('a fixed-position dialog is still found and confirmed', (await acted(p)).slice(-1), ['dialog:Remove']);
  check('and it is closed, not left open behind a success message',
        (await p.evaluate(() => !!document.querySelector('[role="dialog"]'))) === false);
  check('only then does it report the removal', (await statusText(p)).includes('removed from cadence'),
        'status was: ' + await statusText(p));
  await p.close();
}
{
  // Salesloft's own logger popout carries role="dialog".
  const p = await open(ON, { loggerIsDialog: true, confirm: false });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  const s = await statusText(p);
  check('a dialog that was already open is not mistaken for this one',
        s.includes('removed from cadence'), 'status was: ' + s);
  await p.close();
}
{
  const p = await open(ON, { loggerIsDialog: true, confirm: true });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  eq('and the real one is still found past it', (await acted(p)).slice(-1), ['dialog:Remove']);
  await p.close();
}

{
  // An unrelated toast, carrying a dialog role, landing in the same window.
  const p = await open(ON, { toast: true, confirm: false });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  const s = await statusText(p);
  check('a toast about someone else is not mistaken for the confirmation',
        s.includes('removed from cadence'), 'status was: ' + s);
  eq('and it is left alone rather than answered', (await acted(p)).slice(-2),
     ['remove from cadence', 'toast opened']);
  await p.close();
}
{
  const p = await open(ON, { toast: true, confirm: true });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  eq('the real dialog is still found past the toast', (await acted(p)).slice(-1), ['dialog:Remove']);
  await p.close();
}
{
  // The one part of the flow nobody recorded: what the buttons say.
  const p = await open(ON, { confirm: true, confirmButtons: ['Keep them', 'Take them off'] });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  const s = await statusText(p);
  check('an unknown dialog names its own buttons in the status',
        s.includes('"Keep them"') && s.includes('"Take them off"'), 'status was: ' + s);
  await p.close();
}

// ------------------------------------------------------------- failure paths
console.log('\nHow an icon button carries its name');
for (const nameFrom of ['svg-title', 'aria-label', 'title', 'labelledby']) {
  const p = await open(ON, { nameFrom });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  check(`named by ${nameFrom}, the cadence control is still found`,
        (await acted(p)).includes('remove from cadence'), (await statusText(p)));
  await p.close();
}
{
  // The tightest name wins: an outer container holding the whole cadence panel
  // matches on text content too.
  const p = await open(ON, {});
  await p.evaluate(() => {
    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'button');
    wrap.textContent = 'Cadence actions: remove person from cadence, pause, skip';
    wrap.style.cssText = 'width:200px;height:20px';
    document.getElementById('app').prepend(wrap);
    wrap.addEventListener('click', () => window.__acted.push('WRONG: outer container'));
  });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  const a = await acted(p);
  check('and a wrapper that merely mentions it is not clicked instead',
        !a.some((x) => x.startsWith('WRONG')) && a.includes('remove from cadence'), a.join(' | '));
  await p.close();
}

console.log('\nWhose control it is');
{
  // The field report: the queue beside the contact has an identical remove
  // control on every row, and the flow took the first one on the page, which
  // belonged to someone else. Salesloft said "Task removed for <them>".
  const p = await open(ON, { queue: ['Joshua Tan', 'Andreea Boeck'], queueAfter: ['Paul Rohlwing'] });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  const a = await acted(p);
  check('nobody else is removed when their rows come first', !a.some((x) => x.startsWith('REMOVED WRONG')), a.join(' | '));
  check('the person on screen is', a.includes('remove from cadence'), a.join(' | '));
  const s = await statusText(p);
  check('and the status says who', s.includes('Eric Kersten removed from cadence'), 'status was: ' + s);
  await p.close();
}
{
  // Logging re-renders the queue; a reference taken before it, or "the first
  // one", can land on the row that moved up.
  const p = await open(ON, { queueAfter: ['Joshua Tan'], reorderOnLog: true });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  const a = await acted(p);
  check('a queue that reorders on logging still removes the right person',
        a.includes('remove from cadence') && !a.some((x) => x.startsWith('REMOVED WRONG')), a.join(' | '));
  await p.close();
}
{
  // The most dangerous page: the only removal control on it is someone
  // else's, and the contact's name is still in the heading.
  const p = await open(ON, { noRemove: true, queue: ['Joshua Tan'] });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(11000);
  const s = await statusText(p);
  eq('when the only control is someone else\'s, nothing is touched', await acted(p), []);
  check('and it says so', s.startsWith('Stopped:') && s.includes('none was clicked') && s.includes('Nothing was logged'),
        'status was: ' + s);
  await p.close();
}
{
  // Two controls beside this person's name: guessing between them is still a
  // guess, so neither is clicked.
  const p = await open(ON, { queueAfter: ['Eric Kersten'] });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(4000);
  const s = await statusText(p);
  eq('two controls for the same person stop the flow before anything', await acted(p), []);
  check('and say how many it found', s.includes('found 2'), 'status was: ' + s);
  await p.close();
}
{
  const p = await open(ON, { noHeading: true });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(2000);
  const s = await statusText(p);
  eq('a page that does not say whose it is removes nobody', await acted(p), []);
  check('and says why', s.includes('could not tell whose page'), 'status was: ' + s);
  await p.close();
}
{
  // Dialled from a list, the heading is the list's, not a person's. Here it is
  // the cadence's name, which every queue row mentions, and the only row is
  // someone else's: read as a name, it would have picked them.
  const p = await open(ON, { listPage: true, noRemove: true, queue: ['Joshua Tan'] });
  await p.evaluate(() => {
    const h1 = document.createElement('h1');
    h1.textContent = 'Account-Based Targeting';
    document.getElementById('app').prepend(h1);
    window.__slOnMessage({ type: 'dialer-action', action: 'not-in-service', confirmed: true }, null, () => {});
  });
  await p.waitForTimeout(2000);
  eq('off the contact\'s own page, nobody is removed and nothing logged', await acted(p), []);
  await p.close();
}
{
  // "Eric Kersten" must not be found inside a longer name.
  const p = await open(ON, { noRemove: true, queue: ['Eric Kerstenson'] });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(11000);
  eq('a name that merely starts the same is not a match', await acted(p), []);
  await p.close();
}

console.log('\nWhen Salesloft has moved');
{
  const p = await open(ON, { noRemove: true });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(11000);
  const s = await statusText(p);
  check('a missing cadence control names itself rather than saying "element"',
        s.includes('Remove from cadence control') && s.includes('Finish manually'), 'status was: ' + s);
  // It is looked for before anything is touched, so a page without one stops
  // clean: no call ended, nothing logged, nobody removed.
  eq('and it is missed before anything is logged', await acted(p), []);
  await p.close();
}
{
  const p = await open(ON, { noMenuToggle: true });
  await p.click(strip); await p.click(strip); await p.waitForTimeout(11000);
  const s = await statusText(p);
  check('a missing Log Only menu stops before anything logs', s.startsWith('Stopped:'), 'status was: ' + s);
  eq('and nothing was logged or removed', await acted(p), ['disposition=Not in Service']);
  await p.close();
}

// ------------------------------------------------------------- the gates
console.log('\nThe gates');
{
  const p = await open({ ...ON, notInService: false }, {});
  check('off means no control at all', (await p.$(strip)) === null);
  await p.evaluate(() => window.__slOnMessage({ type: 'dialer-action', action: 'not-in-service' }, null, () => {}));
  await p.waitForTimeout(1500);
  eq('and a relayed action does nothing', await acted(p), []);
  await p.close();
}
{
  const p = await open(ON, {});
  await p.click(strip); await p.click(strip);
  await p.waitForTimeout(200);
  // A second trigger mid-flow must be swallowed by the busy flag.
  await p.evaluate(() => window.__slOnMessage({ type: 'dialer-action', action: 'not-in-service' }, null, () => {}));
  await p.waitForTimeout(3000);
  const n = (await acted(p)).filter((a) => a === 'remove from cadence').length;
  eq('busy swallows a second trigger mid-flow', n, 1);
  await p.close();
}
{
  const p = await open({ ...ON, hotkeys: { 'kill-and-log': 'ArrowLeft', 'start-call': 'ArrowRight', 'not-in-service': 'KeyQ' } }, {});
  await p.keyboard.press('q');
  await p.waitForTimeout(300);
  check('a bound key arms rather than firing', (await p.textContent(strip + ' .sl-second-label')) === 'Remove from cadence?');
  eq('and takes no action on its own', await acted(p), []);
  await p.keyboard.press('q');
  await p.waitForTimeout(2500);
  eq('a second press commits', (await acted(p)).slice(-1), ['remove from cadence']);
  await p.close();
}

console.log('\nConfirmed somewhere else');
{
  const p = await open(ON, {});
  await p.evaluate(() => window.__slOnMessage({ type: 'dialer-action', action: 'not-in-service' }, null, () => {}));
  await p.waitForTimeout(500);
  eq('a bare relayed action arms rather than running', await acted(p), []);
  check('and the strip shows it', (await p.textContent(strip + ' .sl-second-label')) === 'Remove from cadence?');
  await p.close();
}
{
  const p = await open(ON, {});
  await p.evaluate(() => window.__slOnMessage({ type: 'dialer-action', action: 'not-in-service', confirmed: true }, null, () => {}));
  await p.waitForTimeout(4000);
  eq('a confirmed one runs straight through — the panel already asked',
     (await acted(p)).slice(-1), ['remove from cadence']);
  await p.close();
}
{
  const p = await open({ ...ON, pageOverlay: false }, {});
  await p.evaluate(() => window.__slOnMessage({ type: 'dialer-action', action: 'not-in-service' }, null, () => {}));
  await p.waitForTimeout(1500);
  eq('with no visible control, arming is refused rather than done blind', await acted(p), []);
  await p.evaluate(() => window.__slOnMessage({ type: 'dialer-action', action: 'not-in-service' }, null, () => {}));
  await p.waitForTimeout(3000);
  eq('so a second press cannot commit either', await acted(p), []);
  await p.close();
}

// ------------------------------------------------------- pane and not-armed
console.log('\nThe transcript pane');
{
  const p = await open({ pageOverlay: true, transcription: true, notInService: false }, {});
  const paneBox = async () => p.evaluate(() => {
    const pane = document.querySelector('#sl-hotkey-overlay [aria-label="Hide transcript"],#sl-hotkey-overlay [aria-label="Show transcript"]')
      .closest('div[style*="border-radius: 11px"]');
    const r = pane.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) };
  });
  eq('open, the pane is 308 x 104', await paneBox(), { w: 308, h: 104 });
  await p.click('#sl-hotkey-overlay [aria-label="Hide transcript"]');
  await p.waitForTimeout(200);
  // A rail: one column of controls. The timer and the line count are on the
  // base row now, so nothing in here needs width for a word.
  eq('collapsed, it is a 34px rail at full height — never auto', await paneBox(), { w: 34, h: 104 });
  const reachable = await p.evaluate(() => ['Show transcript', 'Pause transcription', 'Save transcript as text']
    .map((t) => !!document.querySelector(`#sl-hotkey-overlay [aria-label="${t}"]`)));
  eq('and all three controls stay reachable', reachable, [true, true, true]);
  const sized = await p.evaluate(() => [...document.querySelectorAll('#sl-hotkey-overlay .sl-icon')]
    .map((b) => { const r = b.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }));
  eq('every icon button is 24x24', [...new Set(sized)], ['24x24']);
  await p.close();
}
{
  const p = await open({ pageOverlay: true, transcription: true }, {});
  await p.evaluate(() => window.__slOnMessage({ type: 'transcription-status', state: 'notarmed', detail: 'Ctrl+Shift+8' }, null, () => {}));
  await p.waitForTimeout(150);
  const shown = await p.evaluate(() => {
    const box = document.getElementById('sl-hotkey-overlay');
    const header = [...box.querySelectorAll('span')].find((s) => s.textContent === 'NOT ARMED');
    return {
      header: !!header,
      headerColour: header ? getComputedStyle(header).color : null,
      status: box.querySelector('.sl-status').textContent,
      prompt: [...box.querySelectorAll('div')].some((d) => d.textContent.includes('with Salesloft in front')),
    };
  });
  check('the header says NOT ARMED', shown.header);
  check('in the ordinary muted grey, not amber', shown.headerColour === 'rgb(154, 160, 166)', shown.headerColour);
  check('the status strip is left alone', shown.status === 'Ready', 'status was: ' + shown.status);
  check('the prompt names the key it was handed', shown.prompt);

  await p.evaluate(() => window.__slOnMessage({ type: 'transcript', payload: { start: 1, text: 'hello' } }, null, () => {}));
  await p.waitForTimeout(150);
  const covered = await p.evaluate(() => {
    const box = document.getElementById('sl-hotkey-overlay');
    const prompt = [...box.querySelectorAll('div')]
      .filter((d) => d.textContent.includes('with Salesloft in front')).pop();
    const list = [...box.querySelectorAll('div')].find((d) => d.style.overflowY === 'auto');
    return {
      prompt: getComputedStyle(prompt).display !== 'none',
      list: getComputedStyle(list).display !== 'none',
      line: box.textContent.includes('hello'),
    };
  });
  check('a captured line is never covered by the prompt', !covered.prompt && covered.list && covered.line,
        JSON.stringify(covered));
  await p.close();
}
{
  const p = await open({ pageOverlay: true, transcription: true }, {});
  await p.evaluate(() => window.__slOnMessage({ type: 'transcription-status', state: 'notarmed', detail: 'Ctrl+Shift+8' }, null, () => {}));
  await p.waitForTimeout(100);
  // A settings toggle rebuilds the pane; it must not open on OFFLINE while the
  // body still shows the arming prompt.
  await p.evaluate(() => window.__slOnStorage({ notInService: { newValue: true } }, 'sync'));
  await p.waitForTimeout(300);
  const after = await p.evaluate(() => {
    const box = document.getElementById('sl-hotkey-overlay');
    const header = [...box.querySelectorAll('span')].find((s) => /NOT ARMED|OFFLINE|LIVE/.test(s.textContent));
    const prompt = [...box.querySelectorAll('div')].filter((d) => d.textContent.includes('with Salesloft in front')).pop();
    return { header: header && header.textContent, prompt: prompt && getComputedStyle(prompt).display !== 'none' };
  });
  eq('a rebuilt pane keeps the header the worker last set', after.header, 'NOT ARMED');
  check('with the prompt still under it', after.prompt);
  await p.close();
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) { console.log('failures:\n  ' + errors.join('\n  ')); }
await browser.close();
process.exit(fail ? 1 : 0);
