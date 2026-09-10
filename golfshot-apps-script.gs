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
//      Minutes timer -> Every 15 or 30 minutes.
//   6. Play a round, wait for the trigger to fire (or run it manually to
//      test immediately), then check the dashboard's Golf page.
// ============================================================

const ENDPOINT_URL = 'https://life-dashboard-ten-tau.vercel.app/api/golfshot-import';
const SHARED_SECRET = 'PASTE-THE-SAME-SECRET-YOU-PUT-IN-VERCEL-HERE';

// Adjust this if Golfshot's real sending address turns out to be different —
// check an actual email's "show original" in Gmail to confirm.
const GMAIL_SEARCH = 'from:support@golfshot.com newer_than:3d';

// Remembers which message IDs have already been sent, so a rolling search
// window (newer_than:3d) can't resend the same email as it drifts back into
// view — the endpoint also dedupes by date+course+score as a second layer.
const PROCESSED_KEY = 'golfshot_processed_ids';
const MAX_REMEMBERED = 200;

function checkGolfshotEmails() {
  const props = PropertiesService.getScriptProperties();
  let processed = [];
  try { processed = JSON.parse(props.getProperty(PROCESSED_KEY) || '[]'); } catch (e) {}
  const processedSet = new Set(processed);

  const threads = GmailApp.search(GMAIL_SEARCH);
  let sent = 0;

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      const id = message.getId();
      if (processedSet.has(id)) return;

      const payload = {
        subject: message.getSubject(),
        html: message.getBody(),
        text: message.getPlainBody()
      };

      try {
        const response = UrlFetchApp.fetch(ENDPOINT_URL, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-api-key': SHARED_SECRET },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
        Logger.log('Message ' + id + ' -> ' + response.getResponseCode() + ': ' + response.getContentText());
      } catch (e) {
        Logger.log('Message ' + id + ' FAILED: ' + e.message);
        return; // don't mark as processed if the request itself failed — retry next run
      }

      processedSet.add(id);
      sent++;
    });
  });

  // Cap how many IDs we remember so this doesn't grow forever.
  const trimmed = Array.from(processedSet).slice(-MAX_REMEMBERED);
  props.setProperty(PROCESSED_KEY, JSON.stringify(trimmed));
  Logger.log('Checked ' + threads.length + ' thread(s), sent ' + sent + ' new message(s).');
}
