# Calf Care

A small, installable web app (PWA) for **gentle daily calf-strengthening and circulation exercises**, with guided timers, reminders, a symptom log and built-in safety rules.

- Plain HTML, CSS and JavaScript (ES modules), with **no build step and no dependencies**.
- **No backend, no accounts, no analytics, and no network requests.** All data stays in `localStorage` on your device.
- Works offline once opened, and can be installed to your phone's home screen.

> **Disclaimer:** this is a personal exercise helper, **not medical advice**. Follow guidance from your doctors and physiotherapist.

## Features

| Area | What it does |
|---|---|
| **Today** | A checklist of today's sessions (morning, mid-morning, afternoon, evening, bedtime), a progress bar and a big **Start** button for the next session. |
| **Guided session** | Goes through each exercise in turn, with a "get ready" intro, a large countdown, an automatic rep counter, and a rhythm cue (a soft beat plus a growing/shrinking circle, e.g. 1 s up, 1 s pause, 3 s down). Includes Pause, Skip, rest timers (+15 s), side-switch pauses, an optional tap-to-count mode, **Stop: it hurts**, and the Screen Wake Lock. |
| **12 exercises** | Each has step-by-step instructions, an animated SVG, a default dose, a "go gently" tip and a "stop if" warning. Standing calf raises stay locked until you unlock progression. |
| **Schedule builder** | Templates (Gentle start, Flare day, Building). Add, remove and reorder exercises per slot, set slot times, and adjust reps, sets and durations. |
| **Weekly progression** | Proposes +2 reps, or +1 set at the rep cap (or a little more time). It only applies when you tap **Accept**. You can always choose **Hold** or **Ease back**, and it is **blocked** if you reported pain in the last 7 days. |
| **Log** | After each session: little-toe pain (0–10), heat/redness (0–10), optional room temperature and notes. Shows a weekly chart of sessions against symptoms (with a table view) and gentle streaks that never reset because of rest days. |
| **Safety rules** | Toe pain ≥ 5 or heat/redness ≥ 7 brings up a prompt to stop and do an elevation break, and makes the next session about 40% lighter. A "When to get medical help" panel is always one tap away. |
| **Export** | CSV download, a printable summary (print or save as PDF) for your doctor or physio, and a JSON backup/restore. |
| **Reminders** | Every 30–120 min between set times, or at your slot times. Uses system notifications via the service worker (with *Start now* and *Snooze 10 min*), an in-app banner, and an **.ics calendar export** as the reliable backup. |
| **Settings** | °C/°F, sound, vibration, rep counting mode, large text, light/dark/auto theme, reduce motion, unlock progression, and reset all data. |
| **Accessibility** | Semantic HTML, ARIA labels, a live region for session cues, tap targets of at least 48–56 px, high contrast, a large-text mode, and respect for `prefers-reduced-motion`. |

### About reminders (limitations)

A web app with no server **cannot reliably wake itself at an exact time once fully closed**.

- **Reminders work best while the app is open or in the background.** When it is open you'll see a banner with Start, Snooze and Dismiss.
- **Android (Chrome), installed:** notifications work. Chrome's Periodic Background Sync may also deliver reminders while the app is closed, but Chrome decides the timing.
- **iPhone/iPad:** notifications only work for apps added to the Home Screen from Safari (iOS 16.4+), and iOS still won't fire timed reminders while the app is closed.
- **Most reliable:** Settings → Reminders → **Add to my calendar (.ics)**. Your calendar app will then alert you every day at your reminder times.

## Run it locally

You need [Node.js](https://nodejs.org) 18+ (only for the tiny dev server and the tests; the app itself needs nothing).

```bash
npm start          # serves the app at http://localhost:8080
npm test           # unit tests: timers, rep counter, progression, safety, reminders, CSV
npm run test:e2e   # browser test at phone size (needs Playwright + Chromium installed)
```

Any static server works too, e.g. `python3 -m http.server 8080`. Service workers need `http://localhost` or HTTPS.

## Deploy

There's nothing to build. Upload the folder as-is.

**GitHub Pages:** push to your repository, then go to *Settings → Pages → Build and deployment → Deploy from a branch*, choose `main` and `/ (root)`. The app will be at `https://<user>.github.io/<repo>/`. All paths are relative, so a sub-folder URL works.

**Netlify:** drag the project folder onto <https://app.netlify.com/drop>, or connect the repo with no build command and publish directory `.`.

After you change files, bump `VERSION` in `sw.js` so installed copies pick up the update.

## Install on your phone

1. Open the deployed HTTPS link on your phone.
2. **Android (Chrome):** tap ⋮ → **Install app** (or **Add to Home screen**).
3. **iPhone (Safari):** tap the **Share** button → **Add to Home Screen** → **Add**. Then open Calf Care from the home-screen icon (not from Safari) and turn on reminders in Settings.
4. Open it once while online. After that it works offline.

## Project structure

```
index.html            App shell, dialogs, tab bar
manifest.webmanifest  PWA manifest
sw.js                 Service worker: offline cache, notification actions, periodic sync
css/styles.css        Theme tokens (light/dark), components, illustrations, print styles
js/app.js             Router and all screens (Today, Exercises, Schedule, Log, Settings, Session)
js/engine.js          Session timeline + runner (timers, tempo, reps, rests). DOM-free and tested
js/exercises.js       The 12 exercises: steps, tips, warnings, doses, tempos
js/illustrations.js   Animated SVG illustrations
js/schedule.js        Slots, templates, levels, weekly progression
js/safety.js          Safety thresholds and medical-help text
js/history.js         Log entries, streaks, chart data, CSV, report summary
js/reminders.js       Reminder times, due checks, .ics export, notification glue
js/feedback.js        Soft beats (Web Audio), vibration, Screen Wake Lock
js/chart.js           Weekly SVG chart (sessions + symptoms) with table view
js/store.js           localStorage persistence
icons/                App icons (SVG sources + PNGs; regenerate with `npm run icons`)
tests/                Unit tests (node:test) and an end-to-end browser test
```

## Privacy

No cookies, analytics, fonts or scripts from other sites. A Content-Security-Policy blocks external requests. Your log only leaves the device when you choose to download or share an export.

---

# Fluid Log (in `fluid-log/`)

A second, separate app in this repo: an installable iPhone web app for tracking **fluid intake and urine output**.

- **Today:** a progress ring against your daily target, how much is left, and whether you're on pace for your waking hours. Shows intake, output and balance (in − out), plus a breakdown by drink.
- **Log intake:** one tap on a drink type (Water, Tea, Coffee, Milk, Juice, Soft drink, Soup, Other, or your own), pick a volume, adjust the time if needed, and add an optional note. It remembers the last volume you used for each drink.
- **Log output:** urine volume and time.
- **Edit or delete** any entry (with undo). Browse back to earlier days to see or add entries.
- **History:** 7/14/30/90-day chart of intake vs output vs target, averages, days the target was met, and a day list you can tap into.
- **Daily target:** set in Settings. A new target applies from today, so earlier days are still judged against the target they had.
- **Export:** all entries as CSV, daily totals as CSV, and a JSON backup you can restore. On iPhone this opens the share sheet, so you can save to Files, AirDrop or email.
- ml or US fl oz, light/dark mode, works offline. No accounts and no network requests; data is stored on the device.

URL once GitHub Pages is on: `https://<user>.github.io/<repo>/fluid-log/`

**iPhone:** open the link in Safari → Share → **Add to Home Screen**, then always open it from the home-screen icon. Safari can clear data for sites you haven't visited in a while, but home-screen web apps are exempt. Still, make a JSON backup now and then.

Tests: `npm test` (includes `tests/unit/fluid-log.test.js`). Icons: `node scripts/make-fluid-icons.cjs`. After changing files, bump `VERSION` in `fluid-log/sw.js`.
