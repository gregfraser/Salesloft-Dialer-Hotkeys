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


// ------------------------------------------------------- pane and not-armed
console.log('\nThe transcript pane');
{
  const p = await open({ pageOverlay: true, transcription: true }, {});
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
  await p.evaluate(() => window.__slOnStorage({ transcription: { newValue: true } }, 'sync'));
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
