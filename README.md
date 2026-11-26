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

---

# Trip Planner (in `travel-planner/`)

A third, separate app: an installable web app (works in any browser and on iPhone) for **planning a trip together**: flights, hotels, car hire, drives, trains/ferries and daily activities. It shows what's on today, maps the whole trip, and works out drive times.

- **Today:** the day's timeline, a "Next up" card with a countdown, where you're staying, and car hire in progress. Swipe through the trip with the day strip or the ‹ › arrows.
- **Live checks on Today (AI):** flight tiles have **Check flight status** (on time / delayed / cancelled, new departure time, terminal, gate, arrival, with the source and when it was checked; available from the day before departure). Drive tiles have **Check for delays on the route**: the app gets the main roads from the route and Claude searches for roadworks, closures and incidents on them that day (it can't see live congestion; use Directions in Maps for that). Results are kept on the phone until you tap Refresh.
- **Day summary (AI):** at the bottom of Today, **Summarise this day** gives an overview of the day, the weather, practical tips and suggestions for attractions, restaurants and events near your plans, each with a map link and **Add to plan**. Each check or summary uses Claude with web search and your own API key (a few cents each); the plan details for that day are sent to Anthropic.
- **Ask about this trip (AI chat):** the 💬 button in the top bar opens a chat that knows the whole trip (bookings, times, places, booking references, notes, costs and payments, budget, and the text of attached documents) and can search the web for things like weather and opening hours, with sources. Answers stream in as they're written. The conversation is kept per trip on the phone (**New chat** clears it). It only answers questions; it can't change the plan. Uses your own API key; the trip details are sent to Anthropic with each question.
- **Flight lookup (AI):** when adding a flight, enter just the flight number and date and tap **Find flight**: the airline, airports (placed on the map), local departure and arrival times (including next-day arrivals) and departure/arrival terminals are filled in from the web. Check and save. Existing flights have **Update from the flight number**. Terminals show on the Today tiles.
- **Ideas:** when the chat (or the day summary) recommends restaurants, activities or attractions, each appears as a card with **☆ Save idea**, **＋ Add to plan** and **Map**. Saved ideas go in the shared **💡 Ideas** list at the top of the Plan tab, where admins can add one to the plan (it then leaves Ideas) or remove it; everyone on the trip sees them, and the chat knows about them.
- **Packing list:** Plan → 🎒 Packing. Add the people on the trip, then things to take for **each person**, one person, or **shared**, with categories and quantities; tick them off as they're packed, filter by person, hide packed items, untick all for the trip home. Start from a ready-made list (Ski trip, Beach, City break, Essentials) or **✨ Suggest a list** (Claude looks at the destination, dates, weather, activities and people). Everyone on the trip can tick, including view-only phones, and the chat knows what's still to pack. *Needs the updated `firestore.rules` pasted into Firebase.*
- **Compact tiles:** Today and Plan show the essentials (time, title, one key line, live status chip). Tap ⌄ on a tile for everything (terminals, refs, costs, documents, notes, directions, live checks), or **Expand all / Collapse all**; remembered per phone.
- **Pull to refresh:** pull down at the top of Today (or tap **↻ Refresh**) to re-check live flight status and road checks already run for that day, update times and check for an app update.
- **Directions:** every tile with a place (activities, restaurants, hotels, car pick-up, departure airports, drives) has **🧭 Directions**, and so does every address in a booking. It opens Google Maps (or Apple Maps, under Trip → On this device) with directions from wherever the phone is now; the maps app uses its own live location.
- **Swipe left to delete** a plan on Today or Plan (admin phones): a short swipe shows **Delete**, a long swipe deletes straight away, and there's always **Undo**.
- **Drive times between plans:** when two plans on the same day are in different places (hotel → museum, airport → hotel, back to the hotel at night), it shows the estimated drive time and distance, and warns you when there isn't enough time (**tight** or **you'd be late**). There's a **Directions** link that opens Apple Maps on iPhone and Google Maps elsewhere.
- **Drive planner:** add a drive with *From*, *To* and *Leave at*, and it calculates the duration, distance and arrival time. Add a traffic buffer (+10% by default, set per trip) and time for stops. There's also a stand-alone **Drive time calculator** (Map tab or the + button).
- **Plan:** the whole itinerary, day by day.
- **Map:** every place on an OpenStreetMap map. Flights show as arcs, drives follow the actual roads, and you can filter by day. Tap a pin for details and directions.
- **Place search:** type a place, address or airport and pick from the results. Places you've already used show up as one-tap chips, and you can use your current location.
- **Sharing:** with sync turned on (below), everyone with the trip link sees the same plan and can edit it. Changes appear within seconds, and it works offline (changes sync when you're back online). It shows who last edited each item.
- **Documents:** attach tickets, booking confirmations, PDFs and photos to any booking (up to 10 MB each; large photos are shrunk automatically). Bookings with documents show a 📎 on the timeline, and **Trip → Documents** lists them all in one place. Tap **View** to preview, open, or **Share / Save to Files**. On shared trips everyone sees the documents, and the app downloads them in the background so they're there at the airport with no signal.
- **Costs & Budget:** every booking has a cost (any currency) and a payment status: *Not paid yet*, *Deposit paid* (with the deposit amount and an optional *Balance due by* date) or *Paid in full*. The **Budget** tab shows planned spend against your total budget, paid vs still to pay (deposits count as paid, the balance as still to pay), **Upcoming payments** in date order with overdue balances flagged, spend by category and by day (hotel and car hire costs are spread across their nights/days), and which bookings still have no cost. Set the trip's home currency and exchange rates there; costs in a currency without a rate are flagged rather than silently ignored.
- **Scan bookings (AI):** tap **+ → Scan a booking**, then take a photo, pick a screenshot or PDF, or paste a confirmation email. Claude reads it, finds every booking in it (e.g. outbound and return flights), fills in times, places, booking refs and prices, and puts the places on the map. Review anything that's missing, then add them in one tap. The original is attached to each booking, and for photos the text is saved too. Any image or PDF document can also be turned into text later (**View → Get the text from this document**). See *Turn on scanning* below.
- **Export:** add everything to your calendar (.ics), or download/import a JSON backup (plans only, not documents).

URL once GitHub Pages is on: `https://<user>.github.io/<repo>/travel-planner/`. On iPhone: Safari → Share → **Add to Home Screen**.

**Services used** (free, no API keys): map tiles from OpenStreetMap, place search from [Nominatim](https://nominatim.org), driving routes from the [OSRM](https://project-osrm.org) public server. Drive times don't include live traffic, which is why there's a buffer. These public servers are fine for personal use but have fair-use limits; the app spaces out requests and caches routes on the device.

## Turn on sharing (one-time, about 5 minutes)

Without this, trips are saved only on the device you made them on. To share live with other people, connect the app to a free Firebase database:

1. Go to <https://console.firebase.google.com>, click **Create a project** (Google Analytics is not needed).
2. **Build → Firestore Database → Create database.** Pick a location near you and start in **production mode**.
3. **Firestore → Rules:** replace the rules with the contents of [`travel-planner/firestore.rules`](travel-planner/firestore.rules), then click **Publish**.
4. **Build → Authentication → Get started → Sign-in method → Anonymous → Enable.** (No one has to make an account; this just lets the rules check that the request comes from the app.)
5. **Authentication → Settings → Authorized domains:** add `<user>.github.io`.
6. **Project settings (⚙️) → Your apps → Web (`</>`)**, register an app (no hosting), and copy the `firebaseConfig` values into [`travel-planner/js/config.js`](travel-planner/js/config.js):
   ```js
   export const firebaseConfig = {
     apiKey: 'AIza…',
     authDomain: 'your-project.firebaseapp.com',
     projectId: 'your-project',
     appId: '1:…:web:…',
   };
   ```
   This config is not a secret, so committing it is fine: access is controlled by the rules.
7. Commit, push, and bump `VERSION` in `travel-planner/sw.js`.

Now new trips are shared. Trips you made before turning on sync have a **Move to shared sync** button (Trip tab).

**Documents** are stored in the same Firestore database (split into chunks under 1 MB), so you don't need Firebase Storage, which requires the paid plan on new projects. The free tier includes 1 GB of Firestore storage. Whenever `firestore.rules` changes, paste it into the Firebase console again.

### View link and admin link

Each shared trip has two links, under **Trip → Share**:

| Link | Send it to | They can |
|---|---|---|
| 👁 **View link** | Family and friends | See everything (plan, map, documents, budget), updated live. Can't change anything. |
| ✏️ **Admin link** | The one or two people who manage the plan | Edit everything. Opening it makes that phone an admin of the trip. |

- The phone that creates a trip is its first admin. Admins can see the admin link and **Make a new admin link**, which stops the old one working (phones that are already admins stay admins).
- This is enforced by the database rules, not just hidden in the app: a view-only phone that tries to write is refused.
- Admin rights belong to the *device* (each phone signs in anonymously and gets its own id). If you delete the app, clear Safari's website data or change phone, open your admin link again, so keep it somewhere safe (e.g. a locked note). On iPhone the home-screen app and Safari count as different devices: open admin links from inside the app (**Trips → Join a shared trip**, paste the link).
- The links contain long random codes that can't be guessed, and nobody can list trips. But anyone with either link can see booking references and attached documents, so don't upload passport scans and only send links to people you trust.

The free Firebase tier (50k reads / 20k writes per day) is far more than a family trip needs.

## Turn on scanning (optional)

Scanning uses Claude through the Anthropic API, paid per use. Each scan costs a few cents.

1. Sign in at <https://console.anthropic.com>, add a little credit under **Billing**, then **API keys → Create key**.
2. In the app: **Trip → Scanning bookings**, paste the key and tap **Turn on scanning**.

The key is stored only on that device (it's never put into the shared trip), and the app sends it straight to Anthropic. Anyone else who wants to scan adds their own key, or you add yours on their phone. The scanned document is sent to Anthropic to be read. Check what was filled in before saving: times are kept as printed, and the model can misread a blurry photo.

On iPhone, the easiest way to scan an email is to copy its text (press and hold → Select All → Copy) and paste it in, or take a screenshot of it.

## Shared AI key (optional, so nobody needs their own key)

The AI features normally need an Anthropic key on each phone. Instead, a small free server can hold one key for everyone on your shared trips: [`workers/trip-ai/worker.js`](workers/trip-ai/worker.js), a Cloudflare Worker. Phones never see the key. Each request is checked: it must come from the app's address, carry the phone's Firebase sign-in (verified against Google's keys), belong to a phone on that trip (asked of Firestore, so the database rules decide), stay under a daily limit per phone, and be one of the requests the app makes. Then the key is added and the request is passed to Anthropic.

1. Create a free account at <https://dash.cloudflare.com>.
2. **Workers & Pages → Create → Create Worker** (start from "Hello World"), name it `trip-ai`, click **Deploy**.
3. Click **Edit code**, delete everything, paste the contents of `workers/trip-ai/worker.js`, and click **Deploy**.
4. Worker **Settings → Variables and Secrets → Add**: type **Secret**, name `ANTHROPIC_API_KEY`, value: your Anthropic key. **Deploy**.
5. Daily limit (recommended): **Storage & Databases → KV → Create** a namespace called `trip-ai-usage`. Then the worker's **Settings → Bindings → Add → KV namespace**: variable name `USAGE`, namespace `trip-ai-usage`.
6. Optional variables (Settings → Variables and Secrets, type **Text**): `DAILY_LIMIT` (requests per phone per day, default 40) and `ACCESS` (`everyone` = anyone with the trip link, default; `admins` = admin phones only).
7. Copy the worker's address (like `https://trip-ai.yourname.workers.dev`) into `aiProxyUrl` in [`travel-planner/js/config.js`](travel-planner/js/config.js), commit and push.

Also set a monthly spending limit in the Anthropic Console (Settings → Limits). Phones with their own key keep using it; device-only trips need a key on the phone.

## Natural voice for spoken answers (optional)

Answers in the trip chat can be read aloud. The phone's own voice often sounds robotic, and in Home Screen apps on some iPhones it doesn't play at all. With this set up, the trip server makes natural-sounding speech instead (Cloudflare Workers AI, voice model `@cf/deepgram/aura-2-en`), using Cloudflare's free daily Workers AI allowance first.

1. Worker **Settings → Bindings → Add → Workers AI**, variable name `AI`. Save.
2. Paste the latest `workers/trip-ai/worker.js` into the worker (**Edit code**) and **Deploy**.
3. In the app: **Trip → On this device → Voice** to pick a voice, and **🔊 Test voice → Test natural voice** to hear it.

Optional variable `SPEECH_DAILY_LIMIT` (pieces of speech per phone per day, default 400; answers are read in pieces of a sentence or two).

## Reminders (push notifications)

Phones on a shared trip can get notifications: time to leave (from the drive time), 3 hours before a flight, online check-in, hotel check-out, car return and parking, payments due, packing, and a morning summary. Each phone picks its own in **Trip → Reminders**.

How it works: whenever the plan changes, a phone on the trip works out the reminder list (using each place's time zone, looked up offline from its map location) and sends it to the trip server (the same Cloudflare Worker as the shared AI key). The worker keeps it in KV and a cron trigger sends whatever is due every 5 minutes, as standard Web Push (encrypted to each phone, signed with a key the worker makes for itself on first use). Only short reminder texts and times are stored, and only while some phone has reminders on.

Setup, once the worker from "Shared AI key" is running:

1. Paste the latest `workers/trip-ai/worker.js` into the worker (**Edit code**) and **Deploy**.
2. Make sure the worker has the **KV binding `USAGE`** (step 5 above). Reminders need it.
3. Worker **Settings → Trigger events → Add → Cron trigger**: `*/5 * * * *` (every 5 minutes). Save.
4. On each phone: open the trip, **Trip → Reminders → Turn on reminders**, allow notifications, then **Send a test**.

On iPhone, notifications only work when the app is added to the Home Screen (Safari → Share → Add to Home Screen) and opened from there (iOS 16.4 or later).

## Notes

- Times are stored exactly as you type them (the local time on your ticket), with no time-zone conversion, so a 09:30 departure from London and an 11:20 arrival in New York both show as printed.
- Tests: `npm test` (includes `tests/unit/travel-planner.test.js`) and `npm run test:e2e:travel` (phone-sized browser test with the map and route services mocked).
- `tests/unit/ai-proxy.test.js` checks the AI server: token signatures, trip membership, admins-only mode, allowed requests, daily limit, CORS.
- Sharing tests (need Java and `npm install`): `npm run test:rules` checks `firestore.rules` in the Firestore emulator (viewers can't write, admin links, new admin links); `npm run test:e2e:cloud` runs several phones against the Auth + Firestore emulators with the real Firebase SDK.
- Icons: `node scripts/make-travel-icons.cjs`. After changing files, bump `VERSION` in `travel-planner/sw.js`.
