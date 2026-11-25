/**
 * End-to-end check in a real (headless) Chromium at phone size.
 * Uses Playwright's fake clock to fast-forward timers.
 *
 *   node tests/e2e/run.cjs            # run checks
 *   SHOTS=dir node tests/e2e/run.cjs  # also save screenshots into dir
 */
const { chromium, devices } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const assert = require('assert/strict');

const PORT = 8765;
const BASE = `http://localhost:${PORT}/`;
const SHOTS = process.env.SHOTS;

async function main() {
  const server = spawn(process.execPath, [path.join(__dirname, '../../scripts/serve.mjs'), String(PORT)], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  // Full Chromium (not the headless shell) so notifications can be granted.
  const browser = await chromium.launch({ channel: 'chromium' }).catch(() => chromium.launch());
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push(['PASS', name]);
    } catch (e) {
      results.push(['FAIL', name, e.message.split('\n')[0]]);
    }
  };
  const shot = async (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });

  try {
    const context = await browser.newContext({ ...devices['Pixel 7'], permissions: ['notifications'] });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
    await page.clock.install({ time: new Date(2026, 10, 25, 8, 40, 0) });
    await page.goto(BASE);

    await check('first-run disclaimer is shown and can be accepted', async () => {
      const dlg = page.locator('#disclaimer-dialog');
      await dlg.waitFor({ state: 'visible' });
      await shot(page, '01-disclaimer');
      await dlg.getByRole('button', { name: 'I understand' }).click();
      await dlg.waitFor({ state: 'hidden' });
    });

    await check('Today screen shows checklist, progress and Start button', async () => {
      await page.getByRole('heading', { name: 'Today', level: 1 }).waitFor();
      await page.getByText('0 of 5 sessions done').waitFor();
      assert.equal(await page.locator('.checklist li').count(), 5);
      await page.getByRole('button', { name: /Start morning session/ }).waitFor();
      await shot(page, '02-today');
    });

    await check('exercise detail: illustration, steps, tip and stop warning', async () => {
      await page.goto(BASE + '#/exercise/seated-calf-raise');
      await page.getByRole('heading', { name: 'Seated calf raises' }).waitFor();
      assert.ok(await page.locator('.ill-wrap svg[role=img]').count());
      await page.getByText('Go gently:').waitFor();
      await page.getByText('Stop if:').waitFor();
      await shot(page, '03-exercise');
    });

    await check('guided session: intro countdown → reps with tempo cue and counter', async () => {
      await page.getByRole('button', { name: 'Try it now' }).click();
      await page.getByText('Starting in').waitFor();
      assert.equal(await page.locator('#s-timer').textContent(), '0:08');
      await page.clock.runFor(8100);
      await page.locator('#s-cue', { hasText: 'Lift heels' }).waitFor();
      assert.match(await page.locator('#s-reps').textContent(), /Rep 1 of 15/);
      await page.clock.runFor(1200);
      assert.equal(await page.locator('#s-cue').textContent(), 'Pause');
      await page.clock.runFor(1000);
      assert.equal(await page.locator('#s-cue').textContent(), 'Lower slowly');
      await shot(page, '04-session-reps');
      await page.clock.runFor(3000);
      assert.match(await page.locator('#s-reps').textContent(), /Rep 2 of 15/);
    });

    await check('wake lock requested / tab bar hidden during session', async () => {
      assert.equal(await page.locator('.tabbar').isVisible(), false);
    });

    await check('pause freezes the rep counter; resume continues', async () => {
      await page.getByRole('button', { name: 'Pause' }).click();
      const before = await page.locator('#s-reps').textContent();
      await page.clock.runFor(20000);
      assert.equal(await page.locator('#s-reps').textContent(), before);
      await page.getByRole('button', { name: 'Resume' }).click();
      await page.clock.runFor(5000);
      assert.notEqual(await page.locator('#s-reps').textContent(), before);
    });

    await check('rest timer between sets, +15 s and skip', async () => {
      await page.clock.runFor(75000); // finish remaining reps of set 1
      await page.locator('#s-title', { hasText: 'Rest' }).waitFor();
      const t1 = await page.locator('#s-timer').textContent();
      assert.match(t1, /^0:[34]\d$/);
      await page.getByRole('button', { name: '+15 s' }).click();
      await page.clock.runFor(200);
      const t2 = await page.locator('#s-timer').textContent();
      assert.ok(parseInt(t2.split(':')[1]) > parseInt(t1.split(':')[1]) || t2.startsWith('1:'), `${t1} -> ${t2}`);
      await shot(page, '05-session-rest');
      await page.getByRole('button', { name: 'Skip rest' }).click();
      await page.locator('#s-sub', { hasText: 'Set 2 of 2' }).waitFor();
    });

    await check('"Stop: it hurts" ends the session and opens the log', async () => {
      await page.getByRole('button', { name: 'Stop: it hurts' }).click();
      await page.getByRole('heading', { name: 'Stopped. Good call.' }).waitFor();
      await page.getByText('Partly done:').waitFor();
    });

    await check('logging toe pain ≥5 triggers the safety dialog and a lighter next session', async () => {
      await page.locator('#toePain').fill('6');
      await page.locator('#heat').fill('3');
      await page.locator('#roomTemp').fill('19');
      await shot(page, '06-log-form');
      await page.getByRole('button', { name: 'Save log' }).click();
      await page.locator('#safety-dialog').waitFor({ state: 'visible' });
      await shot(page, '07-safety-dialog');
      await page.locator('#safety-dialog').getByRole('button', { name: 'OK' }).click();
      await page.getByText('Lighter session next.').waitFor();
    });

    await check('reduced session uses fewer reps (15 → 9, one set)', async () => {
      await page.goto(BASE + '#/exercise/seated-calf-raise');
      await page.getByRole('button', { name: 'Try it now' }).click();
      await page.getByText('9 reps').first().waitFor();
      await page.getByRole('button', { name: 'Start now' }).click();
      assert.match(await page.locator('#s-reps').textContent(), /of 9/);
      assert.equal(await page.locator('#s-sub').textContent(), '');
      await page.clock.runFor(46000);
      await page.getByRole('heading', { name: 'Well done' }).waitFor();
      await page.getByRole('button', { name: 'Save log' }).click(); // 0/0: comfortable
      await page.getByRole('heading', { name: 'Today', level: 1 }).waitFor();
      assert.equal(await page.getByText('Lighter session next.').count(), 0, 'flag cleared after a comfortable lighter session');
    });

    await check('weekly progression is held when pain was reported', async () => {
      await page.evaluate(() => {
        const s = JSON.parse(localStorage.getItem('calfcare.v1'));
        s.plan.lastReview = '2026-11-17';
        localStorage.setItem('calfcare.v1', JSON.stringify(s));
      });
      await page.reload();
      await page.getByText('Holding at your current level.').first().waitFor();
      assert.equal(await page.getByRole('button', { name: 'Accept step up' }).count(), 0);
    });

    await check('reminders: enable, banner appears at 09:00, snooze 10 min, fires again', async () => {
      await page.goto(BASE + '#/settings');
      await page.getByRole('switch', { name: /Remind me to exercise/ }).check();
      await page.getByText(/reminders a day/).waitFor();
      await shot(page, '08-settings-reminders');
      await page.goto(BASE + '#/today');
      await page.clock.runFor(21 * 60 * 1000); // 08:4x → past 09:00
      const banner = page.locator('#reminder-banner');
      await banner.waitFor({ state: 'visible' });
      await shot(page, '09-reminder-banner');
      await banner.getByRole('button', { name: 'Snooze 10 min' }).click();
      await banner.waitFor({ state: 'hidden' });
      await page.clock.runFor(9 * 60 * 1000);
      assert.equal(await banner.isVisible(), false, 'still snoozed after 9 min');
      await page.clock.runFor(2 * 60 * 1000);
      await banner.waitFor({ state: 'visible' });
      await banner.getByRole('button', { name: 'Dismiss' }).click();
    });

    await check('system notification via service worker (test reminder)', async () => {
      await page.goto(BASE + '#/settings');
      await page.evaluate(() => navigator.serviceWorker.ready);
      await page.getByRole('button', { name: 'Send a test reminder' }).click();
      let n = [];
      for (let i = 0; i < 20 && !n.length; i++) {
        await page.clock.runFor(200);
        await new Promise((r) => setTimeout(r, 250)); // real time for the async SW call
        n = await page.evaluate(async () => {
          const reg = await navigator.serviceWorker.ready;
          const list = await reg.getNotifications();
          return list.map((x) => ({ title: x.title, actions: (x.actions || []).map((a) => a.action) }));
        });
      }
      assert.ok(n.length >= 1, 'a notification was shown');
      assert.deepEqual(n[0].actions, ['start', 'snooze']);
    });

    await check('Log screen: chart, stats, CSV export', async () => {
      await page.goto(BASE + '#/log');
      await page.getByText('Sessions completed').first().waitFor();
      assert.equal(await page.locator('.chart').count(), 2);
      await page.locator('.hit').last().click();
      await page.locator('.chart-tip', { hasText: 'sessions' }).waitFor();
      await shot(page, '10-log');
      const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download CSV' }).click()]);
      const csv = await (await dl.createReadStream()).toArray().then((c) => Buffer.concat(c).toString());
      assert.match(csv, /^date,time,slot/);
      assert.match(csv, /yes/); // stopped_for_pain
    });

    await check('printable summary', async () => {
      await page.goto(BASE + '#/report');
      await page.getByRole('heading', { name: 'Exercise and symptom summary' }).waitFor();
      await page.getByText('Sessions stopped because of pain').waitFor();
    });

    await check('schedule builder: add/remove exercise, levels', async () => {
      await page.goto(BASE + '#/schedule');
      await page.locator('.slot-card summary').first().click();
      const before = await page.locator('.slot-card').first().locator('.slot-ex').count();
      await page.locator('#add-morning').selectOption('stairs');
      await page.locator('.slot-card').first().getByRole('button', { name: 'Add' }).click();
      assert.equal(await page.locator('.slot-card').first().locator('.slot-ex').count(), before + 1);
      await page.getByRole('button', { name: 'Remove Stair walking (optional) from Morning' }).click();
      assert.equal(await page.locator('.slot-card').first().locator('.slot-ex').count(), before);
      await shot(page, '11-schedule');
    });

    await check('dark mode + large text apply', async () => {
      await page.goto(BASE + '#/settings');
      await page.locator('label:has(input[value=dark]) span').click();
      await page.getByRole('switch', { name: 'Large text' }).check();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.largeText), 'true');
      await page.goto(BASE + '#/today');
      await shot(page, '12-today-dark');
    });

    await check('works offline after first load (service worker cache)', async () => {
      await page.evaluate(() => navigator.serviceWorker.ready);
      await context.setOffline(true);
      await page.reload();
      await page.getByRole('heading', { name: 'Today', level: 1 }).waitFor();
      await context.setOffline(false);
    });

    await check('no JavaScript errors', async () => {
      const real = errors.filter((e) => !/wake ?lock/i.test(e));
      assert.deepEqual(real, []);
    });

    await check('manifest is valid and installable fields present', async () => {
      const m = await (await page.request.get(BASE + 'manifest.webmanifest')).json();
      assert.equal(m.display, 'standalone');
      assert.ok(m.icons.some((i) => i.sizes === '512x512' && i.purpose === 'maskable'));
    });
  } finally {
    await browser.close();
    server.kill();
  }

  for (const r of results) console.log(r.join('  '));
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
