(() => {
  // Bump CURSOR_OVERLAY_VERSION whenever anything in this file changes, the same
  // rule ax-tree.js follows. The helpers are injected on demand, so a page
  // visited before an extension update still holds the previous copy. Matching
  // on the version replaces stale helpers on the next injection and leaves a
  // same-version copy, and the host it already built, untouched. A bare
  // truthiness guard would pin the old code until the page navigated, and a
  // missing guard would stack a second host on the first after the content
  // agent's 45 second idle disconnect re-injects.
  const CURSOR_OVERLAY_VERSION = '0.6.2';
  if (globalThis.UmbraCursor?.version === CURSOR_OVERLAY_VERSION) {
    return globalThis.UmbraCursor;
  }

  // A custom element name, not a div or a span. clickVisibleText defaults its
  // candidate selector to a list that includes span and div, and readInteractive
  // numbers controls by position in a querySelectorAll over button, a[href],
  // input and friends. A node matching either would either steal a click or
  // shift every ref by one. This tag matches neither, carries no light-DOM text
  // and no role, so the accessibility walk drops it as a nameless generic.
  const HOST_TAG = 'umbra-cursor-layer';
  // The self-hide lives in the page, not in the worker. An MV3 service worker
  // evicted mid-sequence would otherwise leave the pointer frozen on screen.
  const AUTO_HIDE_MS = 2_500;
  const MIN_GLIDE_MS = 80;
  const MAX_GLIDE_MS = 1_200;
  const RIPPLE_MS = 520;
  const RIPPLE_STEP_MS = 130;
  const CARET_MS = 720;
  const HINT_MS = 620;
  const TRAIL_FADE_MS = 420;
  const EASING = 'cubic-bezier(0.22, 0.61, 0.36, 1)';
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // Set with the important flag so a page rule like `* { position: static }`
  // cannot re-root or reveal the layer. The host goes on documentElement rather
  // than body, so a `body { transform }` rule does not turn fixed positioning
  // into a containing block that moves with the page.
  const HOST_STYLE = [
    ['position', 'fixed'],
    ['inset', '0'],
    ['pointer-events', 'none'],
    ['z-index', '2147483647'],
    ['isolation', 'isolate'],
    ['contain', 'layout style size'],
    ['margin', '0'],
    ['padding', '0'],
    ['border', '0'],
    ['background', 'none'],
  ];

  const SHADOW_CSS = `
    .layer {
      all: initial;
      position: fixed;
      inset: 0;
      display: block;
      pointer-events: none;
    }
    .layer * {
      pointer-events: none;
      box-sizing: border-box;
    }
    .pointer {
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      opacity: 0;
      transform: translate3d(-200px, -200px, 0);
      transition: opacity 160ms linear;
      /* Outline and glow live here, not on .arrow: clip-path is applied after
         filter on the same element, so a drop shadow on the clipped node is
         clipped away with it. From the parent it traces the child's alpha. */
      filter:
        drop-shadow(1px 0 0 rgba(16, 14, 28, 0.95))
        drop-shadow(-1px 0 0 rgba(16, 14, 28, 0.95))
        drop-shadow(0 1px 0 rgba(16, 14, 28, 0.95))
        drop-shadow(0 -1px 0 rgba(16, 14, 28, 0.95))
        drop-shadow(0 0 1.5px rgba(236, 233, 246, 0.9))
        drop-shadow(0 0 10px rgba(108, 73, 240, 0.7))
        drop-shadow(0 0 18px rgba(138, 108, 255, 0.45));
    }
    .arrow {
      position: absolute;
      top: 0;
      left: 0;
      width: 22px;
      height: 30px;
      background: #8a6cff;
      /* A pointer drawn as one clipped rectangle, tip at 0 0 so the point of the
         arrow sits exactly on the target. No image, because manifest.json
         declares no web_accessible_resources and an extension asset URL is
         unreachable from the page. */
      clip-path: polygon(0 0, 0 22px, 6px 17px, 10px 27px, 14px 25px, 10px 15px, 17px 15px);
    }
    .ripple {
      position: fixed;
      top: 0;
      left: 0;
      width: 34px;
      height: 34px;
      margin: -17px 0 0 -17px;
      border-radius: 50%;
      border: 2px solid rgba(138, 108, 255, 0.92);
      background: rgba(138, 108, 255, 0.18);
      opacity: 0;
    }
    .ripple.warm {
      border-color: rgba(255, 158, 87, 0.95);
      background: rgba(255, 158, 87, 0.2);
    }
    .caret {
      position: fixed;
      top: 0;
      left: 0;
      width: 2px;
      height: 22px;
      margin: -11px 0 0 -1px;
      background: rgba(138, 108, 255, 0.95);
      box-shadow: 0 0 6px rgba(108, 73, 240, 0.75);
      opacity: 0;
    }
    .hint {
      position: fixed;
      top: 0;
      left: 0;
      width: 0;
      height: 0;
      margin: -9px 0 0 -9px;
      border-style: solid;
      border-width: 0 9px 13px 9px;
      border-color: transparent transparent rgba(138, 108, 255, 0.9) transparent;
      opacity: 0;
      filter: drop-shadow(0 1px 2px rgba(16, 14, 28, 0.4));
    }
    .trail {
      position: fixed;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0;
      overflow: visible;
    }
    .trail-line {
      fill: none;
      stroke: rgba(138, 108, 255, 0.85);
      stroke-width: 2.5;
      stroke-linecap: round;
      stroke-linejoin: round;
      stroke-dasharray: 6 5;
    }
  `;

  let host = null;
  let shadow = null;
  let layer = null;
  let pointer = null;
  let hideTimer = 0;
  let visible = false;
  let cursorX = -200;
  let cursorY = -200;

  function finite(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clampDuration(value, fallback) {
    const parsed = Number(value);
    const wanted = Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
    return Math.min(Math.max(wanted, MIN_GLIDE_MS), MAX_GLIDE_MS);
  }

  function transformFor(x, y, extra = '') {
    return `translate3d(${x}px, ${y}px, 0)${extra ? ` ${extra}` : ''}`;
  }

  function ensureHost() {
    if (host && host.isConnected && layer) {
      return host;
    }
    const root = document?.documentElement;
    if (!root) {
      return null;
    }
    host = document.createElement(HOST_TAG);
    for (const [name, value] of HOST_STYLE) {
      host.style.setProperty(name, value, 'important');
    }
    // Closed, so page scripts cannot reach in, and so the content agent's
    // MutationObserver on documentElement never sees the animation. That is what
    // keeps a continuously animating cursor from bumping domVersion four times a
    // second and expiring every outstanding element ref.
    shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    layer = document.createElement('div');
    layer.className = 'layer';
    pointer = document.createElement('div');
    pointer.className = 'pointer';
    const arrow = document.createElement('div');
    arrow.className = 'arrow';
    pointer.appendChild(arrow);
    layer.appendChild(pointer);
    shadow.appendChild(style);
    shadow.appendChild(layer);
    root.appendChild(host);
    placePointer(cursorX, cursorY);
    return host;
  }

  function placePointer(x, y) {
    cursorX = x;
    cursorY = y;
    if (pointer) {
      pointer.style.transform = transformFor(x, y);
    }
  }

  function show() {
    if (!pointer) {
      return;
    }
    pointer.style.removeProperty('transition');
    pointer.style.opacity = '1';
    visible = true;
  }

  function resetHideTimer() {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      hide();
    }, AUTO_HIDE_MS);
  }

  function animate(element, keyframes, options) {
    if (typeof element?.animate !== 'function') {
      return null;
    }
    try {
      return element.animate(keyframes, options);
    } catch {
      // A document without the Web Animations API still gets the static paint.
      return null;
    }
  }

  // Slack on top of the animation's own duration, after which the wait gives up
  // and reports settled anyway.
  const SETTLE_SLACK_MS = 250;

  // Never let a page-owned promise decide when the caller continues. A page
  // script can pause the overlay's animations through document.getAnimations(),
  // and a hidden or occluded tab, which is Umbra's default mode, may not advance
  // its document timeline at all. Either one leaves `animation.finished` pending
  // forever, and the worker awaits this across chrome.scripting.executeScript,
  // so a pending promise here used to hang the whole tool call. The timer is the
  // authority; the animation only ever resolves it earlier.
  function settleAfter(animation, durationMs) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(done, Math.max(0, Number(durationMs) || 0) + SETTLE_SLACK_MS);
      if (animation && typeof animation.finished?.then === 'function') {
        animation.finished.then(done, done);
      }
    });
  }

  function spawnTransient(node, keyframes, durationMs, delayMs = 0) {
    if (!layer || !node) {
      return;
    }
    layer.appendChild(node);
    const animation = animate(node, keyframes, {
      duration: durationMs,
      delay: delayMs,
      easing: EASING,
      fill: 'forwards',
    });
    const remove = () => {
      try {
        node.remove();
      } catch {
        // The layer was torn down under it, which is already the end state.
      }
    };
    if (animation && typeof animation.finished?.then === 'function') {
      animation.finished.then(remove, remove);
      return;
    }
    setTimeout(remove, durationMs + delayMs + 60);
  }

  async function glideTo(spec = {}) {
    try {
      if (!ensureHost() || !pointer) {
        return false;
      }
      const x = finite(spec.x, cursorX);
      const y = finite(spec.y, cursorY);
      const durationMs = clampDuration(spec.durationMs, 320);
      const from = transformFor(cursorX, cursorY);
      const to = transformFor(x, y);
      show();
      placePointer(x, y);
      const animation = animate(pointer, [{ transform: from }, { transform: to }], {
        duration: durationMs,
        easing: EASING,
        fill: 'none',
      });
      await settleAfter(animation, durationMs);
      resetHideTimer();
      return true;
    } catch {
      return false;
    }
  }

  function ripple(spec = {}) {
    try {
      if (!ensureHost() || !layer) {
        return false;
      }
      const x = finite(spec.x, cursorX);
      const y = finite(spec.y, cursorY);
      const variant = ['click', 'rightClick', 'double', 'triple'].includes(spec.variant)
        ? spec.variant
        : 'click';
      const count = variant === 'triple' ? 3 : variant === 'double' ? 2 : 1;
      show();
      placePointer(x, y);
      for (let index = 0; index < count; index += 1) {
        const node = document.createElement('div');
        node.className = variant === 'rightClick' ? 'ripple warm' : 'ripple';
        node.style.transform = transformFor(x, y, 'scale(0.35)');
        spawnTransient(
          node,
          [
            { transform: transformFor(x, y, 'scale(0.35)'), opacity: 0.95 },
            { transform: transformFor(x, y, 'scale(1.6)'), opacity: 0 },
          ],
          RIPPLE_MS,
          index * RIPPLE_STEP_MS,
        );
      }
      resetHideTimer();
      return true;
    } catch {
      return false;
    }
  }

  async function dragPath(spec = {}) {
    try {
      if (!ensureHost() || !layer) {
        return false;
      }
      const points = Array.isArray(spec.points)
        ? spec.points
          .map((point) => ({ x: finite(point?.x, NaN), y: finite(point?.y, NaN) }))
          .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
        : [];
      if (points.length < 2) {
        return false;
      }
      const durationMs = clampDuration(spec.durationMs, 480);
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'trail');
      const line = document.createElementNS(SVG_NS, 'polyline');
      line.setAttribute('class', 'trail-line');
      line.setAttribute('points', points.map((point) => `${point.x},${point.y}`).join(' '));
      svg.appendChild(line);
      spawnTransient(
        svg,
        [{ opacity: 0.9 }, { opacity: 0.9 }, { opacity: 0 }],
        durationMs + TRAIL_FADE_MS,
      );
      show();
      const keyframes = points.map((point) => ({ transform: transformFor(point.x, point.y) }));
      placePointer(points[points.length - 1].x, points[points.length - 1].y);
      const animation = animate(pointer, keyframes, {
        duration: durationMs,
        easing: EASING,
        fill: 'none',
      });
      await settleAfter(animation, durationMs);
      resetHideTimer();
      return true;
    } catch {
      return false;
    }
  }

  function typing(spec = {}) {
    try {
      if (!ensureHost() || !layer) {
        return false;
      }
      const x = finite(spec.x, cursorX);
      const y = finite(spec.y, cursorY);
      show();
      placePointer(x, y);
      const caret = document.createElement('div');
      caret.className = 'caret';
      caret.style.transform = transformFor(x, y);
      spawnTransient(
        caret,
        [
          { transform: transformFor(x, y), opacity: 1 },
          { transform: transformFor(x, y), opacity: 0.15 },
          { transform: transformFor(x, y), opacity: 1 },
          { transform: transformFor(x, y), opacity: 0 },
        ],
        CARET_MS,
      );
      resetHideTimer();
      return true;
    } catch {
      return false;
    }
  }

  function scrollHint(spec = {}) {
    try {
      if (!ensureHost() || !layer) {
        return false;
      }
      const x = finite(spec.x, cursorX);
      const y = finite(spec.y, cursorY);
      const direction = ['up', 'down', 'left', 'right'].includes(spec.direction)
        ? spec.direction
        : 'down';
      const rotation = { up: 0, right: 90, down: 180, left: 270 }[direction];
      const travel = 18;
      const shift = {
        up: { x: 0, y: -travel },
        down: { x: 0, y: travel },
        left: { x: -travel, y: 0 },
        right: { x: travel, y: 0 },
      }[direction];
      show();
      placePointer(x, y);
      const chevron = document.createElement('div');
      chevron.className = 'hint';
      const base = `rotate(${rotation}deg)`;
      chevron.style.transform = transformFor(x, y, base);
      spawnTransient(
        chevron,
        [
          { transform: transformFor(x, y, base), opacity: 0.9 },
          { transform: transformFor(x + shift.x, y + shift.y, base), opacity: 0 },
        ],
        HINT_MS,
      );
      resetHideTimer();
      return true;
    } catch {
      return false;
    }
  }

  // Viewport CSS pixels, or null. A ref that no longer resolves and a selector
  // that matches nothing both return null, and the caller skips the animation
  // instead of turning a cosmetic miss into a tool error.
  function measure(target = {}) {
    try {
      const selector = typeof target?.selector === 'string' ? target.selector.trim() : '';
      const ref = typeof target?.ref === 'string' ? target.ref.trim() : '';
      if (!ref && !selector) {
        // Opt-in only. A plain scroll names no element and asks for
        // fallback: 'viewport', so the chevron has somewhere to draw. Every
        // other caller gets null, which is what lets browser_click_text run its
        // real action first and place the cursor from the matched element
        // afterwards. Returning the viewport centre unconditionally made that
        // branch unreachable and drew the click marker in empty space.
        if (target?.fallback === 'viewport') {
          return {
            x: Math.round((window.innerWidth || 0) / 2),
            y: Math.round((window.innerHeight || 0) / 2),
            rect: null,
          };
        }
        return null;
      }
      let element = null;
      if (ref) {
        const ax = globalThis.UmbraAxTree;
        if (typeof ax?.resolveElementRef !== 'function' || typeof ax?.getSharedRefStore !== 'function') {
          return null;
        }
        const resolved = ax.resolveElementRef(ax.getSharedRefStore(), ref);
        if (!resolved || resolved.__error || !resolved.element) {
          return null;
        }
        element = resolved.element;
      } else if (selector) {
        element = document.querySelector(selector);
      }
      if (typeof element?.getBoundingClientRect !== 'function') {
        return null;
      }
      const rect = element.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        return null;
      }
      return {
        x: rect.left + (rect.width / 2),
        y: rect.top + (rect.height / 2),
        rect: {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        },
      };
    } catch {
      return null;
    }
  }

  function hide() {
    try {
      clearTimeout(hideTimer);
      hideTimer = 0;
      visible = false;
      if (pointer) {
        // No fade on the way out. browser_screenshot hides the pointer and
        // captures on the next turn, and a 160 ms fade would land half of it in
        // the PNG.
        pointer.style.setProperty('transition', 'none');
        pointer.style.opacity = '0';
      }
      // Every ripple, caret pulse, scroll chevron and drag trail is a separate
      // node with its own 520 to 720 ms animation. Fading only the arrow left
      // all of those still on screen, so a screenshot taken right after a click
      // captured a purple ring. They are removed outright rather than faded,
      // for the same reason the pointer gets no transition.
      if (layer) {
        for (const node of [...layer.children]) {
          if (node !== pointer) {
            node.remove();
          }
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  function state() {
    return {
      visible,
      x: cursorX,
      y: cursorY,
      version: CURSOR_OVERLAY_VERSION,
    };
  }

  function destroy() {
    try {
      clearTimeout(hideTimer);
      hideTimer = 0;
      visible = false;
      host?.remove();
    } catch {
      // A host already detached by a page rewrite is the end state anyway.
    }
    host = null;
    shadow = null;
    layer = null;
    pointer = null;
    return true;
  }

  const api = {
    version: CURSOR_OVERLAY_VERSION,
    ensureHost,
    glideTo,
    ripple,
    dragPath,
    typing,
    scrollHint,
    measure,
    hide,
    state,
    destroy,
  };

  globalThis.UmbraCursor = api;
  // Built once, here, before content-agent.js starts its observer. Creating the
  // host later would cost one domVersion bump on a live page.
  try {
    ensureHost();
  } catch {
    // A document that refuses the host still gets an API whose calls no-op.
  }
  return api;
})();
