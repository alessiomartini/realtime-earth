#!/usr/bin/env node
/**
 * Live verification against the deployed site.
 *
 * The sandbox this project is developed in has no outbound network, so no feed
 * can be exercised there — every module correctly shows "Failed to fetch", which
 * proves the error path and nothing else. This script drives a real browser
 * against the deployed origin and asserts that data actually arrives.
 *
 * It checks what the site claims, not merely that pages render:
 *
 *   - the home grid links to every feed;
 *   - opening a feed produces received data, or an honest error naming a cause;
 *   - the global counter counts LIVE arrivals only;
 *   - the temperature map returns a real reading under the pointer, and reports
 *     which grid point it came from and how far away that is;
 *   - a feed that opens with history says how much history it loaded.
 *
 * Usage: node scripts/verify-live.mjs <base-url>
 */

import { chromium } from 'playwright';

const BASE = process.argv[2];
if (!BASE) {
  console.error('Usage: node scripts/verify-live.mjs <base-url>');
  process.exit(1);
}

const failures = [];
const notes = [];

function check(condition, message) {
  if (condition) console.log(`  ok   ${message}`);
  else {
    console.log(`  FAIL ${message}`);
    failures.push(message);
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));

console.log(`\n== home: ${BASE}`);
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

const tiles = await page.locator('.tile').count();
check(tiles > 0, `home shows ${tiles} feed tiles`);
check(pageErrors.length === 0, `no uncaught page errors${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`);

const ids = await page.locator('.tile').evaluateAll((nodes) =>
  nodes.map((n) => n.getAttribute('href')?.replace('/m/', '') ?? ''),
);
check(ids.every(Boolean), `every tile links to a feed page (${ids.join(', ')})`);

// The counter must reflect live arrivals — but feeds connect lazily, so it
// only means anything once the grid is actually in view. Scroll to it first;
// reading the counter from the top of the page measures the reader's scroll
// position, not the site.
await page.locator('.counter').scrollIntoViewIfNeeded();
await page.waitForTimeout(10000);
const counter = Number((await page.locator('.counter__value').innerText()).replace(/[^0-9]/g, ''));
check(counter > 0, `global counter is counting live arrivals on the home grid (${counter})`);

for (const id of ids) {
  console.log(`\n== feed: /m/${id}`);
  await page.goto(`${BASE}/m/${id}`, { waitUntil: 'domcontentloaded' });
  // Long enough for a poll to land, a socket to open, and history to load.
  await page.waitForTimeout(12000);

  const title = (await page.locator('.module__title').innerText()).trim();
  check(title.length > 0, `page renders: ${title}`);

  const errorVisible = await page.locator('.card__error').isVisible();
  const errorText = errorVisible ? (await page.locator('.card__error').innerText()).trim() : null;

  const readout = await page.locator('.readout').innerText();
  const live = Number(readout.match(/RECEIVED LIVE\n([\d,]+)/i)?.[1]?.replace(/,/g, '') ?? '0');
  const history = readout.match(/HISTORY LOADED\n(.+)/i)?.[1]?.trim() ?? 'none';
  const age = readout.match(/AGE OF LAST DATUM\n(.+)/i)?.[1]?.trim() ?? '—';

  if (errorText !== null) {
    // An error is an acceptable outcome — but only a specific one. A blank or
    // generic failure would mean the site is hiding why nothing is showing.
    check(errorText.length > 30, `states a specific reason: ${errorText}`);
    notes.push(`/m/${id} reported an error: ${errorText}`);
  } else {
    const gotSomething = live > 0 || history !== 'none';
    check(gotSomething, `received data (live ${live}, history ${history}, age ${age})`);
    check(age !== '—' || live === 0, `age of last datum comes from the source (${age})`);
  }

  if (id === 'surface-temperature' && errorText === null) {
    const box = await page.locator('.worldmap').boundingBox();
    if (box) {
      await page.mouse.move(box.x + box.width * 0.52, box.y + box.height * 0.42);
      await page.waitForTimeout(2500);
      const grid = (await page.locator('.readout-line').first().innerText()).replace(/\n/g, ' ');
      const exact = (await page.locator('.readout-line').nth(1).innerText()).replace(/\n/g, ' ');
      check(/°C/.test(grid), `hover reports a grid temperature: ${grid}`);
      check(/nearest grid point/.test(grid), 'hover names the grid point it used and its distance');
      check(/°C/.test(exact), `hover fetches the exact point: ${exact}`);
    }
  }
}

console.log('\n== notes');
for (const note of notes) console.log(`  - ${note}`);

await browser.close();

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`);
process.exit(failures.length === 0 ? 0 : 1);
