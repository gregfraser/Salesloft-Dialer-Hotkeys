// Shared spring motion.
//
// Ported from the Plate + Dialer design prototype rather than reimplemented, so
// the shipped motion is the designed motion and not an approximation of it.
// Loaded as a plain script by every context that animates (content script via
// the manifest, panel and settings via a <script> tag), so all three surfaces
// share one integrator and one requestAnimationFrame loop.
//
// Why springs and not CSS transitions: a drag that is thrown has to hand its
// release velocity to whatever carries it to rest, and no CSS easing can accept
// a velocity. Once the drag needs a spring, everything beside it may as well use
// the same one, or the overlay animates in two different accents.

(function (root) {
  'use strict';

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // Rubber band: resistance grows with the overshoot, so dragging past an edge
  // slows to a stop instead of hitting a wall.
  const rubber = (over, dim) => (over * dim * 0.55) / (dim + 0.55 * Math.abs(over));
  const band = (v, min, max, dim) =>
    v < min ? min - rubber(min - v, dim) : v > max ? max + rubber(v - max, dim) : v;

  // Where a flick would come to rest: velocity in px/s against a 0.998-per-ms
  // decay. Used to pick the spring's target, not to animate the travel.
  const project = (v) => (v / 1000) * 0.998 / (1 - 0.998);

  const mix = (a, b, p) => a.map((c, i) => Math.round(c + (b[i] - c) * clamp(p, 0, 1)));

  // One loop for every spring in this context. Springs add themselves when they
  // have somewhere to go and drop out the moment they settle, so an overlay
  // sitting idle on the page costs no frames at all.
  const live = new Set();
  let raf = null;
  let last = 0;
  const tick = (t) => {
    // Capped: a backgrounded tab resumes with a huge delta, and an uncapped one
    // would throw every spring across the screen on the first frame back.
    const dt = Math.min(0.032, last ? (t - last) / 1000 : 0.016);
    last = t;
    for (const s of live) s.step(dt);
    if (live.size) raf = requestAnimationFrame(tick);
    else { raf = null; last = 0; }
  };
  const run = () => { if (!raf) raf = requestAnimationFrame(tick); };

  function reducedMotion() {
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) {
      return false;   // no matchMedia (the Node test harness); animate as normal
    }
  }

  // duration is the period in seconds, bounce is 0 (critically damped) to ~0.4.
  function makeSpring(x0, apply, duration, bounce) {
    let zeta = Math.max(0.08, 1 - (bounce || 0));
    let omega = 2 * Math.PI / (duration || 0.4);
    const s = {
      x: x0,
      v: 0,
      target: x0,
      tune(d, b) { zeta = Math.max(0.08, 1 - (b || 0)); omega = 2 * Math.PI / (d || 0.4); },
      step(dt) {
        // Fixed sub-steps: a snappy spring diverges under explicit Euler at a
        // full frame's dt, which reads on screen as the element juddering.
        let leftover = dt;
        while (leftover > 0) {
          const h = Math.min(1 / 480, leftover);
          leftover -= h;
          s.v += (-omega * omega * (s.x - s.target) - 2 * zeta * omega * s.v) * h;
          s.x += s.v * h;
        }
        if (Math.abs(s.x - s.target) < 0.0015 && Math.abs(s.v) < 0.02) {
          s.x = s.target;
          s.v = 0;
          live.delete(s);
        }
        apply(s.x);
      },
      to(target, velocity) {
        s.target = target;
        if (velocity != null) s.v = velocity;
        // Checked per call rather than captured once, so a rep who turns the OS
        // setting on mid-session does not have to reload the Salesloft tab.
        if (reducedMotion()) {
          s.x = target;
          s.v = 0;
          live.delete(s);
          apply(target);
          return;
        }
        live.add(s);
        run();
      },
      // Follow the pointer exactly: no integration, no settle check.
      hold(x) { s.x = x; s.v = 0; live.delete(s); apply(x); },
    };
    apply(x0);
    return s;
  }

  // The press. Down is near-instant because that is the interface saying it
  // heard the rep; the release is relaxed and slightly springy.
  //
  // `enabled` is optional and consulted at press time, not at wiring time: a
  // button whose click is about to be ignored must not answer as though it was
  // not, and whether it will be ignored is only known when the press happens.
  function pressable(btn, enabled) {
    const s = makeSpring(1, (v) => { btn.style.transform = `scale(${v})`; }, 0.12, 0);
    const down = () => { s.tune(0.12, 0); s.to(0.962); };
    const up = () => { s.tune(0.34, 0.22); s.to(1); };
    btn.addEventListener('pointerdown', (e) => {
      if (enabled && !enabled()) return;
      // Captured so the release still lands on this button: the press scales it
      // out from under the cursor, and pointerleave would fire mid-press.
      try { btn.setPointerCapture(e.pointerId); } catch (err) { /* not available */ }
      down();
    });
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    return s;
  }

  // A slot that holds no space at all until it is opened, then springs the
  // layout apart. The natural size is measured lazily off scrollHeight —
  // a mount-time read can land before layout and would pin the slot shut
  // forever — and the negative margin cancels the parent's gap while closed, so
  // a closed slot is absent from the layout rather than merely empty.
  function makeSlot(slot, options) {
    const opts = options || {};
    const axis = opts.axis || 'col';
    const gap = opts.gap || 0;
    const child = opts.child || slot.firstElementChild;
    let natural = 0;
    return makeSpring(0, (p) => {
      const size = clamp(p, 0, 1);
      const open = p > 0.995;
      // Visible only when fully open, so a focus ring or a tooltip inside is not
      // clipped once it has arrived.
      slot.style.overflow = open ? 'visible' : 'hidden';
      if (!natural) natural = (axis === 'col' ? slot.scrollHeight : slot.scrollWidth) || 0;
      if (axis === 'col') {
        slot.style.height = open ? '' : `${(natural * size).toFixed(2)}px`;
        slot.style.marginBottom = `${(-gap * (1 - size)).toFixed(2)}px`;
      } else {
        slot.style.width = open ? '' : `${(natural * size).toFixed(2)}px`;
        slot.style.marginInlineEnd = `${(-gap * (1 - size)).toFixed(2)}px`;
      }
      if (child) {
        child.style.transformOrigin = axis === 'col' ? '0% 100%' : '100% 50%';
        // Held back behind the size so the content arrives into space that has
        // already opened, instead of racing it.
        child.style.opacity = clamp((p - 0.18) / 0.55, 0, 1).toFixed(3);
        child.style.transform = `scale(${(0.9 + 0.1 * p).toFixed(4)})`;
      }
    }, opts.duration || 0.44, opts.bounce == null ? 0.3 : opts.bounce);
  }

  root.slSpring = makeSpring;
  root.slPressable = pressable;
  root.slSlot = makeSlot;
  root.slClamp = clamp;
  root.slBand = band;
  root.slProject = project;
  root.slMix = mix;
  root.slReducedMotion = reducedMotion;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      slSpring: makeSpring,
      slPressable: pressable,
      slSlot: makeSlot,
      slClamp: clamp,
      slBand: band,
      slProject: project,
      slMix: mix,
      slReducedMotion: reducedMotion,
    };
  }
})(typeof self !== 'undefined' ? self : globalThis);
