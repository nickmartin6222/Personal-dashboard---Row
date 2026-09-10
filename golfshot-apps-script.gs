// ============================================================
// Golfshot -> dashboard import
//
// Runs inside YOUR OWN Gmail account via Google Apps Script (script.google.com)
// — not part of the deployed site. It watches for new Golfshot round-completion
// emails and forwards each one's content to /api/golfshot-import, which reads
// it with Gemini and logs the round into the dashboard's golf data.
//
// SETUP:
//   1. Go to script.google.com -> New project.
//   2. Delete the default code, paste this whole file in.
//   3. Replace ENDPOINT_URL and SHARED_SECRET below with your real values —
//      SHARED_SECRET must exactly match GOLFSHOT_IMPORT_SECRET in Vercel.
//   4. Run `checkGolfshotEmails` once manually (Run button) — Google will ask
//      you to authorize Gmail access the first time. Check the execution log
//      for what it found.
//   5. Add a time-based trigger: clock icon (Triggers) on the left -> +
//      Add Trigger -> function: checkGolfshotEmails -> Time-driven ->
//      Minutes timer -> Every minute (the shortest Apps Script offers —
//      there's no true instant push without a lot more infrastructure,
//      see the note below; 1 minute is close enough in practice).
//   6. One-time backfill of every past round: run `backfillAllGolfshotEmails`
//      manually instead (see notes on that function below) — do this once,
//      separately from the timer.
// ============================================================

const ENDPOINT_URL = 'https://life-dashboard-ten-tau.vercel.app/api/golfshot-import';
const SHARED_SECRET = 'PASTE-THE-SAME-SECRET-YOU-PUT-IN-VERCEL-HERE';

// Adjust the sender if Golfshot's real address turns out different — check
// an actual email's "Show original" in Gmail to confirm.
const GOLFSHOT_SENDER = 'from:support@golfshot.com';

// Remembers which message IDs have already been sent, so a rolling search
// window can't resend the same email as it drifts back into view — the
// endpoint also dedupes by date+course+score as a second layer.
const PROCESSED_KEY = 'golfshot_processed_ids';
const MAX_REMEMBERED = 500;

function loadProcessed_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROCESSED_KEY);
  try { return new Set(JSON.parse(raw || '[]')); } catch (e) { return new Set(); }
}
function saveProcessed_(set) {
  const trimmed = Array.from(set).slice(-MAX_REMEMBERED);
  PropertiesService.getScriptProperties().setProperty(PROCESSED_KEY, JSON.stringify(trimmed));
}
function sendMessage_(message) {
  const payload = { subject: message.getSubject(), html: message.getBody(), text: message.getPlainBody() };
  const response = UrlFetchApp.fetch(ENDPOINT_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': SHARED_SECRET },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  return response;
}

// Ongoing watcher — checks only the last few days, meant to run on a
// short timer (every 1 minute is the shortest Apps Script allows; that's
// the practical ceiling for "instant" here — genuinely instant push exists
// via Gmail API watch() + Cloud Pub/Sub, but that needs its own Google
// Cloud project and a subscription that must be renewed every 7 days, real
// extra infrastructure for a personal project. 1-minute polling is close
// enough that the difference is never actually noticeable.)
function checkGolfshotEmails() {
  const processed = loadProcessed_();
  const threads = GmailApp.search(GOLFSHOT_SENDER + ' newer_than:3d');
  let sent = 0;

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const id = message.getId();
      if (processed.has(id)) return;
      try {
        const response = sendMessage_(message);
        Logger.log('Message ' + id + ' -> ' + response.getResponseCode() + ': ' + response.getContentText());
      } catch (e) {
        Logger.log('Message ' + id + ' FAILED: ' + e.message);
        return; // don't mark as processed if the request itself failed — retry next run
      }
      processed.add(id);
      sent++;
    });
  });

  saveProcessed_(processed);
  Logger.log('Checked ' + threads.length + ' thread(s), sent ' + sent + ' new message(s).');
}

// One-time backfill of every past Golfshot email, no date limit. Capped at
// BACKFILL_BATCH per run to stay well inside Apps Script's ~6-minute
// execution limit — if you have more rounds than that, just run this
// function again (Run button) and it picks up wherever it left off, since
// already-sent messages are skipped via the same processed-id tracking.
// Keep re-running until the log says "sent 0" — that means it's caught up.
const BACKFILL_BATCH = 15;
function backfillAllGolfshotEmails() {
  const processed = loadProcessed_();
  const threads = GmailApp.search(GOLFSHOT_SENDER);
  let sent = 0;

  outer:
  for (const thread of threads) {
    for (const message of thread.getMessages()) {
      const id = message.getId();
      if (processed.has(id)) continue;
      try {
        const response = sendMessage_(message);
        Logger.log('Message ' + id + ' -> ' + response.getResponseCode() + ': ' + response.getContentText());
      } catch (e) {
        Logger.log('Message ' + id + ' FAILED: ' + e.message);
        continue;
      }
      processed.add(id);
      sent++;
      if (sent >= BACKFILL_BATCH) break outer;
    }
  }

  saveProcessed_(processed);
  Logger.log('Backfill: found ' + threads.length + ' thread(s) total, sent ' + sent + ' this run. Re-run if sent > 0.');
}
