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
      origSet(k, v);
      try { if (!suppressSync && writeMatches(k)) { schedulePush(); } } catch (e) {}
    };
    localStorage.removeItem = function (k) {
      origRemove(k);
      try { if (!suppressSync && writeMatches(k)) { schedulePush(); } } catch (e) {}
    };

    function applyRemote(remote) {
      if (!remote || typeof remote !== 'object') return false;
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
        const { error } = await supa.from('app_state').upsert(
          { key: appKey, data: state, updated_at: new Date().toISOString() },
          { onConflict: 'key' }
        );
        if (!error) rememberPushed(json);
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
        fetch(SUPABASE_URL + '/rest/v1/app_state?on_conflict=key', {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': 'Bearer ' + SUPABASE_KEY,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify({ key: appKey, data: state, updated_at: new Date().toISOString() }),
          keepalive: true,
        }).catch(() => {});
        // Best-effort — the request is fire-and-forget (can't await in
        // an unload handler), so this optimistically assumes it lands.
        rememberPushed(json);
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

    return { flush: flushNow };
  };
})();
