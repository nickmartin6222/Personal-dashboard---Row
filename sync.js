// =============================================================
// Shared cloud-sync helper for the dashboard.
// Each page calls initCloudSync({...}) once with its config:
//   appKey         — string row key in the public.app_state table
//   syncedKeys     — exact localStorage keys to mirror (read AND write —
//                    local changes to these get pushed up)
//   syncedPrefixes — localStorage key prefixes to mirror (e.g. 'goals:')
//   pullOnlyKeys   — exact localStorage keys this page reads but never
//                    writes (e.g. a page showing another page's data in
//                    a mini-tile). Pulled/applied like syncedKeys, but
//                    NEVER included in this page's own push payload —
//                    without this, a page that only ever *displays*
//                    someone else's data would still re-push its own
//                    (possibly stale) copy of it on every local write to
//                    ANYTHING it owns, or on every navigation-away
//                    (flushOnUnload fires on every page leave), silently
//                    clobbering a genuinely newer edit made on the
//                    actual owning page moments earlier.
//   onApplied      — optional callback after remote state has been applied
//
// Requires:
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>
//   <script src="sync.js" defer></script>
// =============================================================
(function () {
  'use strict';

  // Prefer Vercel env vars (served via /api/config → window.DASH_*),
  // otherwise fall back to these defaults.
  const SUPABASE_URL = (typeof window !== 'undefined' && window.DASH_SUPABASE_URL) || 'https://srajryooffirbroltjmg.supabase.co';
  const SUPABASE_KEY = (typeof window !== 'undefined' && window.DASH_SUPABASE_KEY) || 'sb_publishable_5142ZwTLF_DkSVRzciNuRA_bHwRAu4c';

  window.initCloudSync = function (config) {
    const appKey = config && config.appKey;
    const syncedKeys = (config && config.syncedKeys) || [];
    const syncedPrefixes = (config && config.syncedPrefixes) || [];
    const pullOnlyKeys = (config && config.pullOnlyKeys) || [];
    const onApplied = config && config.onApplied;
    if (!appKey) return;
    if (!window.supabase) return;
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    if (SUPABASE_URL.indexOf('PASTE-') === 0 || SUPABASE_KEY.indexOf('PASTE-') === 0) return;

    let supa = null;
    let pushTimer = null;
    let suppressSync = false;
    // Persisted across page loads (not just this session) — the JSON of
    // the synced keys as of the last CONFIRMED successful push from
    // THIS browser. Lets init() below tell "local matches what I last
    // know was pushed" apart from "local has changes nothing has ever
    // pushed" — the second case covers a page that just got sync wired
    // up for the first time (or was offline/crashed before its last
    // push completed): without this, its initial pull would treat the
    // empty in-memory lastSyncedJson as "nothing local to protect" and
    // blindly overwrite real unsynced local data with a stale remote
    // copy that never had it.
    const LAST_PUSHED_KEY = '__sync_lastPushed_' + appKey;
    let lastSyncedJson = null;
    try { lastSyncedJson = localStorage.getItem(LAST_PUSHED_KEY); } catch (e) {}
    // Set once the initial pull-vs-push decision below has actually run.
    // CRITICAL: pushNow() refuses to push until this is true — without
    // it, an unrelated write that lands before the initial remote fetch
    // resolves (e.g. an exchange-rate refresh, which is a totally
    // separate fetch that can simply finish first) would schedule a
    // push built from collect() BEFORE this tab has pulled its real
    // synced data down at all. That push would upsert an incomplete
    // snapshot over the real remote row — a full replace, not a merge —
    // silently wiping any key this tab hadn't loaded yet. This is
    // exactly what happened to real net-worth data once; the gate below
    // is the fix.
    let initialSyncDone = false;
    let pendingPushAfterInit = false;

    // ---- Per-page undo/redo journal (in-memory only — see the plan doc
    // for why this deliberately does NOT persist across reloads or cross
    // to other pages/tabs/devices). Multiple writes happening in the same
    // tick (e.g. one user action that touches 3 keys) batch into a single
    // undo step via the zero-delay batchTimer below. ----
    let undoStack = [];
    let redoStack = [];
    let pendingBatch = null;
    let batchTimer = null;
    const HISTORY_MAX = 40;
    function queueUndoEntry(k, before, after) {
      // Same reasoning as the initialSyncDone push-gate above: a write
      // that lands before the initial pull has resolved (the exchange-
      // rate cache refresh, an eager first render) isn't a real user
      // action — journaling it makes the very first Back click on a
      // freshly loaded page revert an invisible system write instead of
      // doing nothing, which reads as "I didn't touch anything, why did
      // that change?" Once the real sync handshake has completed,
      // everything after is a genuine local edit worth journaling.
      if (!initialSyncDone) return;
      if (!pendingBatch) pendingBatch = { ts: Date.now(), entries: [] };
      pendingBatch.entries.push({ k: k, before: before, after: after });
      clearTimeout(batchTimer);
      batchTimer = setTimeout(function () {
        if (pendingBatch && pendingBatch.entries.length) {
          undoStack.push(pendingBatch);
          if (undoStack.length > HISTORY_MAX) undoStack.shift();
          // A genuine new write makes any pending "redo" stale.
          redoStack.length = 0;
        }
        pendingBatch = null;
      }, 0);
    }
    // Restores one batch's `before` (undo) or `after` (redo) values.
    // Uses origSet/origRemove directly (like applyRemote) so restoring
    // isn't itself captured as a new undoable action, then pushes for
    // real afterward — an undo/redo is a genuine local change and must
    // sync exactly like any other edit.
    function applyHistoryBatch(batch, direction) {
      suppressSync = true;
      try {
        batch.entries.forEach(function (e) {
          const val = e[direction];
          try { if (val == null) origRemove(e.k); else origSet(e.k, val); } catch (err) {}
        });
      } finally { suppressSync = false; }
      schedulePush();
      if (typeof onApplied === 'function') { try { onApplied(); } catch (err) {} }
    }
    function undo() {
      if (!undoStack.length) return false;
      const batch = undoStack.pop();
      redoStack.push(batch);
      if (redoStack.length > HISTORY_MAX) redoStack.shift();
      applyHistoryBatch(batch, 'before');
      return true;
    }
    function redo() {
      if (!redoStack.length) return false;
      const batch = redoStack.pop();
      undoStack.push(batch);
      if (undoStack.length > HISTORY_MAX) undoStack.shift();
      applyHistoryBatch(batch, 'after');
      return true;
    }
    function canUndo() { return undoStack.length > 0; }
    function canRedo() { return redoStack.length > 0; }

    // Write-eligible: this page may push local changes to these keys.
    function writeMatches(k) {
      if (!k) return false;
      if (syncedKeys.indexOf(k) !== -1) return true;
      for (let i = 0; i < syncedPrefixes.length; i++) {
        if (k.indexOf(syncedPrefixes[i]) === 0) return true;
      }
      return false;
    }
    // Read-eligible: everything write-eligible, plus pull-only keys this
    // page mirrors for display but must never push back up.
    function readMatches(k) {
      if (writeMatches(k)) return true;
      return pullOnlyKeys.indexOf(k) !== -1;
    }
    function listKeys(matchFn) {
      const out = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (matchFn(k)) out.push(k);
      }
      return out;
    }
    function collect() {
      const out = {};
      for (const k of listKeys(writeMatches)) {
        const v = localStorage.getItem(k);
        if (v == null) continue;
        try { out[k] = JSON.parse(v); } catch (e) { out[k] = v; }
      }
      return out;
    }

    const origSet = localStorage.setItem.bind(localStorage);
    const origRemove = localStorage.removeItem.bind(localStorage);
    localStorage.setItem = function (k, v) {
      const before = writeMatches(k) ? localStorage.getItem(k) : null;
      origSet(k, v);
      try {
        if (!suppressSync && writeMatches(k)) { queueUndoEntry(k, before, v); schedulePush(); }
      } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      const before = writeMatches(k) ? localStorage.getItem(k) : null;
      origRemove(k);
      try {
        if (!suppressSync && writeMatches(k)) { queueUndoEntry(k, before, null); schedulePush(); }
      } catch (e) {}
    };

    // Best-known snapshot of the FULL remote row (every key, not just
    // this page's own) — kept in sync on every pull, applied-or-not, so
    // a push never has to guess what the rest of the row currently
    // holds. See pushNow()/flushOnUnload() for why this matters: this
    // appKey can be a row multiple pages contribute DIFFERENT keys to
    // (e.g. po-coach: Workouts owns po_coach_v1, Stats owns only
    // po_coach_weights) — blindly upserting collect() (this page's own
    // keys only) replaces the WHOLE row and silently deletes every key
    // this page doesn't own. This is exactly what wiped real workout
    // data: Stats logging a body-weight entry pushed {po_coach_weights}
    // alone, and Supabase upsert doesn't merge, it replaces.
    let lastKnownRemoteData = {};
    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
      lastKnownRemoteData = remote;
      suppressSync = true;
      let changed = false;
      try {
        for (const k of Object.keys(remote)) {
          if (!readMatches(k)) continue;
          const incoming = JSON.stringify(remote[k]);
          const local = localStorage.getItem(k);
          if (local !== incoming) {
            try { origSet(k, incoming); changed = true; } catch (e) {}
          }
        }
        for (const k of listKeys(readMatches)) {
          if (!(k in remote)) {
            try { origRemove(k); changed = true; } catch (e) {}
          }
        }
      } finally { suppressSync = false; }
      if (changed && typeof onApplied === 'function') {
        try { onApplied(); } catch (e) {}
      }
      return changed;
    }

    function rememberPushed(json) {
      lastSyncedJson = json;
      try { origSet(LAST_PUSHED_KEY, json); } catch (e) {}
    }
    // Overlays this page's own writeMatches keys onto a full remote
    // snapshot — added/changed keys take the local value, a key this
    // page owns but no longer has locally (a real deletion) is dropped,
    // and every key this page doesn't own passes through untouched.
    // This is what makes it safe for a page that only owns PART of a
    // shared row to push at all.
    function mergeOwnKeysInto(remoteSnapshot, localState) {
      const merged = Object.assign({}, remoteSnapshot || {});
      for (const k of Object.keys(merged)) {
        if (writeMatches(k) && !(k in localState)) delete merged[k];
      }
      Object.assign(merged, localState);
      return merged;
    }
    async function pushNow() {
      if (!supa) return;
      if (!initialSyncDone) {
        // Defer — see the comment on initialSyncDone above. Re-attempted
        // automatically once init() below finishes either applying the
        // real remote state or deciding local should win.
        pendingPushAfterInit = true;
        return;
      }
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        // Fetch the latest remote row right before writing — safer than
        // trusting a possibly-stale cached copy, and cheap since this
        // only runs on the debounced push path (not on every keystroke).
        const { data: existing } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        const remoteSnapshot = (existing && existing.data) || lastKnownRemoteData;
        const merged = mergeOwnKeysInto(remoteSnapshot, state);
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: merged, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) { rememberPushed(json); lastKnownRemoteData = merged; }
      } catch (e) {}
    }
    function schedulePush() {
      clearTimeout(pushTimer);
      pushTimer = setTimeout(pushNow, 250);
    }
    // For a write the caller knows is important to not lose (e.g. a
    // settings/goal edit right before the user is likely to navigate
    // away) — pushes immediately instead of waiting out the normal
    // 250ms debounce, shrinking the window where a fast tab-close/
    // navigation could beat the push and leave the edit stranded
    // locally until flushOnUnload (best-effort, not guaranteed on every
    // browser) or the next write picks it up.
    function flushNow() {
      clearTimeout(pushTimer);
      return pushNow();
    }
    function flushOnUnload() {
      // Same gate as pushNow() — never fire a snapshot before the
      // initial pull has resolved (see initialSyncDone above). Worst
      // case here, a tab closed within that first instant just misses
      // flushing an in-flight edit on the way out, same as any other
      // best-effort unload save can already miss — nothing new lost,
      // and nothing risked overwritten.
      if (!initialSyncDone) return;
      const state = collect();
      const json = JSON.stringify(state);
      if (json === lastSyncedJson) return;
      try {
        // Can't await a fresh GET in an unload handler, so this merges
        // into the last-known remote snapshot (kept current on every
        // pull — see applyRemote/init/the realtime subscription) rather
        // than blindly overwriting the whole row with just this page's
        // own keys. Slightly stale if another device pushed since our
        // last pull, but far safer than a guaranteed-wrong full replace.
        const merged = mergeOwnKeysInto(lastKnownRemoteData, state);
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: merged, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        // Best-effort — the request is fire-and-forget (can't await in
        // an unload handler), so this optimistically assumes it lands.
        rememberPushed(json);
        lastKnownRemoteData = merged;
      } catch (e) {}
    }

    (async function init() {
      supa = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY);
      try {
        const currentLocalJson = JSON.stringify(collect());
        // Local differs from the last CONFIRMED push FROM THIS BROWSER
        // (persisted across page loads, not just this session) — real
        // unsynced changes are sitting here, most likely from a push
        // that never completed (crash, closed too fast, offline). This
        // is the ONLY signal allowed to make local win over a non-empty
        // remote (see below) — deliberately narrower than it used to be.
        const hasUnsyncedLocalChanges = lastSyncedJson != null && currentLocalJson !== lastSyncedJson;
        const { data, error } = await supa
          .from('app_state').select('data').eq('key', appKey).maybeSingle();
        if (!error && data && data.data) lastKnownRemoteData = data.data;
        if (!error && data && data.data && Object.keys(data.data).length > 0) {
          // Remote already has real data. The ONLY reason to push local
          // over it is hasUnsyncedLocalChanges — a genuine prior push
          // from THIS browser that didn't make it up. Deliberately NOT
          // gated on "local changed since boot" or "never synced before
          // but local isn't empty": this page's own script can write to
          // synced keys (an exchange-rate cache refresh, an eager first
          // render before this pull even resolves) well before the real
          // remote data has been pulled down — on a browser that's never
          // confirmed a push, that self-inflicted write used to read as
          // "local has real changes, push it", which upserts an
          // incomplete local snapshot straight over the real remote row
          // (a full replace, not a merge) and silently deletes whatever
          // keys this tab hadn't loaded yet. That's the exact bug that
          // wiped real net-worth data. A browser with no confirmed push
          // of its own has nothing worth preserving over an already-
          // established remote state, full stop.
          if (hasUnsyncedLocalChanges) {
            schedulePush();
          } else {
            lastSyncedJson = JSON.stringify(data.data);
            applyRemote(data.data);
          }
        } else if (Object.keys(collect()).length > 0) {
          schedulePush();
        }
      } catch (e) {
      } finally {
        initialSyncDone = true;
        if (pendingPushAfterInit) { pendingPushAfterInit = false; schedulePush(); }
      }
      supa.channel('app_state_' + appKey)
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'app_state',
          filter: 'key=eq.' + appKey,
        }, (payload) => {
          if (!payload.new || !payload.new.data) return;
          const incoming = JSON.stringify(payload.new.data);
          if (incoming === lastSyncedJson) return;
          lastSyncedJson = incoming;
          applyRemote(payload.new.data);
        })
        .subscribe();
    })();

    window.addEventListener('beforeunload', flushOnUnload);
    window.addEventListener('pagehide', flushOnUnload);
    window.addEventListener('storage', (e) => {
      if (e.key && writeMatches(e.key)) schedulePush();
    });

    // Page-scoped registry so a single shared Back/Forward control (see
    // topbar.js) can find "whichever synced data on THIS page has the
    // most recent undoable change" without knowing appKeys in advance —
    // a page can call initCloudSync more than once (e.g. health.html
    // syncs both health-metrics and po-coach). Deliberately just an
    // in-page array on window, not anything persisted or cross-tab.
    if (!window.__dashUndoRegistry) window.__dashUndoRegistry = [];
    window.__dashUndoRegistry.push({
      appKey: appKey,
      undo: undo,
      redo: redo,
      canUndo: canUndo,
      canRedo: canRedo,
      lastUndoTs: function () { return undoStack.length ? undoStack[undoStack.length - 1].ts : 0; },
      lastRedoTs: function () { return redoStack.length ? redoStack[redoStack.length - 1].ts : 0; },
    });

    return { flush: flushNow, undo: undo, redo: redo, canUndo: canUndo, canRedo: canRedo };
  };
})();
