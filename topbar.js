// =============================================================
// Persistent dashboard top bar.
// Drop this on any page with:
//     <script src="topbar.js" defer></script>
// It self-injects HTML + CSS for the top bar and bottom tab bar.
// =============================================================
(function () {
  'use strict';

  // -------- CSS --------
  const css = `
.topbar {
  position: sticky; top: 0; z-index: 40;
  display: flex; justify-content: flex-end; align-items: center;
  gap: 8px;
  padding: max(10px, env(safe-area-inset-top)) 14px 8px;
  background: #0a0a0b;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.topbar-finance-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 42px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  border-radius: 12px;
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s;
}
.topbar-finance-btn:hover { background: rgba(255, 255, 255, 0.08); }
.topbar-finance-icon {
  font-size: 20px; line-height: 1;
  filter: grayscale(100%) brightness(1.4);
  opacity: 0.85;
}
.home-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 42px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  border-radius: 12px;
  font-size: 18px; line-height: 1;
  cursor: pointer;
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s;
}
.home-btn:hover { background: rgba(255, 255, 255, 0.08); }
.theme-btn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 42px;
  border: 1px solid rgba(255, 255, 255, 0.10);
  background: rgba(255, 255, 255, 0.04);
  border-radius: 12px;
  font-size: 18px; line-height: 1;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  transition: background 0.15s;
}
.theme-btn:hover { background: rgba(255, 255, 255, 0.08); }
/* Fixed top-right chrome for pages that suppress the normal topbar
   (currently just finance) — a persistent way home without relying on
   scroll position or a browser back gesture. */
.floating-chrome {
  position: fixed; top: max(14px, env(safe-area-inset-top)); right: 14px;
  z-index: 110; display: flex; gap: 8px;
}

/* Bottom tab bar — Instagram-style */
.bottombar {
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 40;
  display: flex; justify-content: space-around; align-items: stretch;
  padding: 6px 0 calc(6px + env(safe-area-inset-bottom));
  background: #0a0a0b;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, "Inter", "Segoe UI", Roboto, sans-serif;
}
.bottombar-tab {
  flex: 1;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 3px;
  padding: 6px 0 4px;
  text-decoration: none;
  color: rgba(255, 255, 255, 0.45);
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.04em;
  -webkit-tap-highlight-color: transparent;
  transition: color 0.15s;
}
.bottombar-tab-icon {
  font-size: 24px; line-height: 1;
  filter: grayscale(100%) brightness(1.2);
  opacity: 0.55;
  transition: opacity 0.15s, filter 0.15s, transform 0.10s;
}
.bottombar-tab.active {
  color: #FAFAFA;
}
.bottombar-tab.active .bottombar-tab-icon {
  filter: grayscale(100%) brightness(1.6);
  opacity: 1;
}
.bottombar-tab:active .bottombar-tab-icon { transform: scale(0.92); }

/* Push page content above the fixed bottom bar */
body.has-bottombar {
  padding-bottom: calc(72px + env(safe-area-inset-bottom)) !important;
}

@media (max-width: 480px) {
  .topbar { padding-left: 10px; padding-right: 10px; gap: 6px; }
  .topbar-finance-btn { width: 40px; height: 38px; }
  .topbar-finance-icon { font-size: 18px; }
  .bottombar-tab-icon { font-size: 22px; }
  .bottombar-tab { font-size: 10px; }
}

/* === Light theme overrides ===
   Additive only — never edits the rules above, so dark mode (the
   default, no [data-theme] attribute) can't be affected by this. */
[data-theme="light"] .topbar {
  background: #FFFFFF;
  border-bottom-color: rgba(20,18,15,0.08);
}
[data-theme="light"] .topbar-finance-btn,
[data-theme="light"] .home-btn,
[data-theme="light"] .theme-btn {
  background: #FFFFFF;
  border-color: rgba(20,18,15,0.12);
}
[data-theme="light"] .topbar-finance-btn:hover,
[data-theme="light"] .home-btn:hover,
[data-theme="light"] .theme-btn:hover {
  background: rgba(20,18,15,0.06);
}
[data-theme="light"] .topbar-finance-icon {
  filter: grayscale(100%) brightness(0.7);
}
[data-theme="light"] .bottombar {
  background: #FFFFFF;
  border-top-color: rgba(20,18,15,0.10);
}
[data-theme="light"] .bottombar-tab { color: rgba(20,18,15,0.45); }
[data-theme="light"] .bottombar-tab-icon { filter: grayscale(100%) brightness(0.7); }
[data-theme="light"] .bottombar-tab.active { color: #1C1B17; }
[data-theme="light"] .bottombar-tab.active .bottombar-tab-icon {
  filter: grayscale(100%) brightness(0.3);
}

/* === Global mobile lockdown ===
   1) Hide the right-side scrollbar on phones (iOS uses overlay scrollbars anyway).
   2) Stop iOS auto-text-size-adjust.
   3) touch-action: pan-y prevents pinch-zoom while still allowing vertical scroll.
   4) overscroll-behavior on every common modal class stops scroll chaining —
      scrolling inside a settings popup won't drag the page behind it.
   5) When body has .topbar-modal-open, the page can't scroll at all (locked).
*/
html, body {
  -webkit-text-size-adjust: 100%;
}
@media (max-width: 768px) {
  html { touch-action: pan-y; }
  ::-webkit-scrollbar { width: 0; height: 0; display: none; }
  html, body { scrollbar-width: none; -ms-overflow-style: none; }
}
.modal-bg, .modal, .po-modal-bg, .po-modal, .wt-overlay, .wt-viewer {
  overscroll-behavior: contain;
}
body.topbar-modal-open {
  overflow: hidden;
  touch-action: none;
}
/* On phones, blow the modals up to full screen and let them be the only
   scrolling element. Way less "is this scrolling the page or the modal?"
   confusion. */
@media (max-width: 480px) {
  .modal-bg, .po-modal-bg {
    padding: 0 !important;
    align-items: stretch !important;
    justify-content: stretch !important;
  }
  .modal, .po-modal {
    width: 100% !important;
    max-width: 100% !important;
    max-height: 100vh !important;
    height: 100vh !important;
    border-radius: 0 !important;
    padding-top: max(20px, env(safe-area-inset-top)) !important;
    padding-bottom: max(28px, env(safe-area-inset-bottom)) !important;
    overflow-y: auto !important;
    overscroll-behavior: contain;
  }
}
`;

  // -------- HTML --------
  const topbarHtml = `
<header class="topbar" id="topbar" role="navigation" aria-label="Quick actions">
  <a href="FROK-finance-standalone.html" class="topbar-finance-btn" id="topbarFinance" aria-label="Finance">
    <span class="topbar-finance-icon">📊</span>
  </a>
</header>
`;

  const bottombarHtml = `
<nav class="bottombar" id="bottombar" role="navigation" aria-label="Main tabs">
  <a href="index.html" class="bottombar-tab" data-page="main">
    <span class="bottombar-tab-icon">🏠</span>
    <span>Main</span>
  </a>
  <a href="gym.html" class="bottombar-tab" data-page="fitness">
    <span class="bottombar-tab-icon">💪</span>
    <span>Fitness</span>
  </a>
  <a href="golf.html" class="bottombar-tab" data-page="golf">
    <span class="bottombar-tab-icon">⛳</span>
    <span>Golf</span>
  </a>
</nav>
`;

  // Pages where we suppress the app chrome: finance has its own internal
  // bottom nav and self-contained back button.
  function isFinancePage() {
    const p = (window.location.pathname || '').toLowerCase();
    return p.endsWith('finance.html') || p.endsWith('frok-finance-standalone.html') || p.includes('finance-preview');
  }
  // Pages embedded in an iframe shouldn't render their own chrome again.
  function isEmbedded() {
    try { return window.self !== window.top; } catch (e) { return true; }
  }
  function shouldShowChrome() {
    return !isFinancePage() && !isEmbedded();
  }
  function currentPageKey() {
    const p = (window.location.pathname || '').toLowerCase();
    if (p.endsWith('gym.html')) return 'fitness';
    if (p.endsWith('golf.html')) return 'golf';
    // health.html has no bottombar tab of its own (hidden from nav for now) —
    // falls back to 'main' so at least Home lights up if someone lands there.
    return 'main'; // index.html, health.html, /, or anything else falls back to main
  }

  function injectStyleAndHTML() {
    if (!document.getElementById('topbar-style')) {
      const style = document.createElement('style');
      style.id = 'topbar-style';
      style.textContent = css;
      document.head.appendChild(style);
    }

    if (document.getElementById('topbar') || document.getElementById('bottombar')) return;
    if (!shouldShowChrome()) return;

    const topWrap = document.createElement('div');
    topWrap.innerHTML = topbarHtml.trim();
    document.body.insertBefore(topWrap.firstChild, document.body.firstChild);

    const bottomWrap = document.createElement('div');
    bottomWrap.innerHTML = bottombarHtml.trim();
    document.body.appendChild(bottomWrap.firstChild);

    // Highlight the active bottom tab.
    const active = currentPageKey();
    document.querySelectorAll('.bottombar-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-page') === active);
    });

    // Reserve room above the fixed bottom bar so page content can scroll
    // past it without being hidden.
    document.body.classList.add('has-bottombar');
  }

  // Shared fixed top-right container for pages with no normal topbar
  // (currently just finance) — holds the Home button.
  function getFloatingChrome() {
    let el = document.getElementById('floatingChrome');
    if (!el) {
      el = document.createElement('div');
      el.id = 'floatingChrome';
      el.className = 'floating-chrome';
      document.body.appendChild(el);
    }
    return el;
  }

  function injectHomeButton() {
    if (isEmbedded()) return;
    if (document.getElementById('topbar')) return; // topbar already has a way home via the bottombar
    if (document.getElementById('homeBtn')) return;

    const btn = document.createElement('a');
    btn.id = 'homeBtn';
    btn.href = 'index.html';
    btn.className = 'home-btn';
    btn.setAttribute('aria-label', 'Back to dashboard');
    btn.textContent = '🏠';
    getFloatingChrome().appendChild(btn);
  }

  // -------- Shared light/dark theme toggle --------
  // The dashboard's own mint/sage toggle and this button both read/write
  // the same key — gym/golf/finance/health/nutrition already ship full
  // [data-theme="light"] CSS, they just never had a control to reach it.
  const THEME_KEY = 'dash:colorTheme';
  function applyStoredTheme() {
    const v = localStorage.getItem(THEME_KEY);
    if (v === 'sage') document.documentElement.setAttribute('data-theme', 'light');
    else document.documentElement.removeAttribute('data-theme');
  }
  function injectThemeToggle() {
    if (isEmbedded()) return;
    // index.html has its own themed pill switch already wired to the
    // same key — don't add a second, redundant control there.
    if (document.getElementById('themeToggle')) return;
    if (document.getElementById('themeBtn')) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'themeBtn';
    btn.className = 'theme-btn';
    btn.setAttribute('aria-label', 'Toggle light / dark theme');
    function paintIcon() {
      btn.textContent = document.documentElement.getAttribute('data-theme') === 'light' ? '🌙' : '☀️';
    }
    paintIcon();
    btn.addEventListener('click', () => {
      const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'mint' : 'sage';
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      applyStoredTheme();
      paintIcon();
    });

    const topbar = document.getElementById('topbar');
    if (topbar) topbar.appendChild(btn);
    else getFloatingChrome().appendChild(btn);
  }
  window.addEventListener('storage', (e) => {
    if (e.key === THEME_KEY) applyStoredTheme();
  });

  // -------- Mobile lockdown helpers --------
  // Belt-and-suspenders zoom prevention — iOS Safari sometimes ignores
  // user-scalable=no, so we also kill the gesture events directly.
  function blockGesture(e) { e.preventDefault(); }
  function lockGestures() {
    document.addEventListener('gesturestart', blockGesture, { passive: false });
    document.addEventListener('gesturechange', blockGesture, { passive: false });
    document.addEventListener('gestureend', blockGesture, { passive: false });
    // Also kill the iOS double-tap-to-zoom on any tap.
    let lastTouch = 0;
    document.addEventListener('touchend', (e) => {
      const now = Date.now();
      if (now - lastTouch <= 300) e.preventDefault();
      lastTouch = now;
    }, { passive: false });
  }

  // Watch every known modal-bg / overlay class — when any one of them
  // gets `.show` or `.is-open`, lock the body scroll. When the last
  // one closes, unlock.
  function startModalLock() {
    const MODAL_SELECTORS = [
      '.modal-bg', '.po-modal-bg', '.wt-overlay', '.wt-viewer', '.wt-cam'
    ];
    function anyOpen() {
      for (const sel of MODAL_SELECTORS) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          if (el.classList.contains('show') || el.classList.contains('is-open')) {
            return true;
          }
        }
      }
      return false;
    }
    function sync() {
      document.body.classList.toggle('topbar-modal-open', anyOpen());
    }
    const observer = new MutationObserver(sync);
    // Observe class changes anywhere in body — modal toggles are rare so
    // a global subtree observer is cheap.
    observer.observe(document.body, {
      attributes: true, attributeFilter: ['class'], subtree: true
    });
    sync();
  }

  // -------- Boot --------
  // Apply the stored theme immediately (not deferred with the rest of
  // boot()) so pages without their own inline theme script don't flash
  // dark before flipping to light.
  applyStoredTheme();

  function boot() {
    injectStyleAndHTML();
    injectHomeButton();
    injectThemeToggle();
    lockGestures();
    startModalLock();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
