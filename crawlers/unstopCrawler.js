// crawlers/unstopCrawler.js
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const OUTPUT_DIR = path.join(__dirname, '..', 'data');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'unstop.json');
const START_URL = 'https://unstop.com/hackathons?oppstatus=open&usertype=students&domain=2';

// tiny sleep helper (avoids page.waitForTimeout compatibility issues)
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// retry wrapper (simple)
async function retry(fn, attempts = 3, delayMs = 1000) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}

// scroll to bottom helper — keeps scrolling until no more height changes
async function autoScroll(page, scrollDelay = 500) {
  let previousHeight = await page.evaluate('document.body.scrollHeight');
  while (true) {
    await page.evaluate('window.scrollTo(0, document.body.scrollHeight)');
    await sleep(scrollDelay);
    const newHeight = await page.evaluate('document.body.scrollHeight');
    if (newHeight === previousHeight) break;
    previousHeight = newHeight;
  }
}

async function run() {
  console.log('Starting Unstop crawler...');
  // prepare output dir
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: "new",                // avoids old headless deprecation warnings
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 800 },
  });

  try {
    const page = await browser.newPage();

    // set a realistic user agent
    await page.setUserAgent('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

    // optional: reduce detection by enabling navigator.webdriver = false
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // go to start url
    await page.goto(START_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // auto scroll to load lazy items (Unstop loads on scroll)
    await autoScroll(page, 700);

    // give a small wait to allow last items to render
    await sleep(800);

    // selector capturing each listing card anchor (based on observed markup)
    const items = await page.$$eval('app-competition-listing a.item, a.item.opp_', anchors => {
      // map DOM to plain objects
      return anchors.map(a => {
        try {
          const titleEl = a.querySelector('h2') || a.querySelector('.double-wrap');
          const title = titleEl ? titleEl.innerText.trim() : '';
          const orgEl = a.querySelector('.cptn p') || a.querySelector('.single-wrap');
          const organization = orgEl ? orgEl.innerText.trim() : '';
          const href = a.href || (a.getAttribute('href') || '').startsWith('http') ? a.href : ('https://unstop.com' + (a.getAttribute('href') || ''));
          const imgEl = a.querySelector('img');
          const image = imgEl ? imgEl.src : null;

          // tags / chips
          const chipEls = Array.from(a.querySelectorAll('.chip_text, .skill_list .chip_text, un-chip .chip_text'));
          const tags = chipEls.map(e => e.innerText.trim()).filter(Boolean);

          // small info area: find 'Registered', 'Online' 'Posted' 'days left'
          const registeredMatch = (() => {
            const regNode = Array.from(a.querySelectorAll('div, span')).find(n => /\bRegistered\b/i.test(n.innerText || ''));
            if (regNode) {
              // find a number nearby
              const txt = regNode.innerText || '';
              const m = txt.match(/(\d[\d,]*)/);
              return m ? m[1].replace(/,/g, '') : null;
            }
            return null;
          })();

          // location
          const locationNode = Array.from(a.querySelectorAll('div, span')).find(n => /\bOnline\b|\bOffline\b|\bIn-person\b|\bHybrid\b/i.test(n.innerText || ''));
          const location = locationNode ? locationNode.innerText.trim() : null;

          // posted date and days left
          const postedNode = Array.from(a.querySelectorAll('span, div')).find(n => /\bPosted\b/i.test(n.innerText || '') || /\bdays left\b/i.test(n.innerText || ''));
          const postedText = postedNode ? postedNode.innerText.trim() : null;

          // participation info (e.g., "Individual Participation" or "Team")
          const participationNode = Array.from(a.querySelectorAll('div, span')).find(n => /Individual Participation|Team/.test(n.innerText || ''));
          const participation = participationNode ? participationNode.innerText.trim() : '';

          return {
            title,
            organization,
            href,
            image,
            tags,
            registered: registeredMatch,
            location,
            postedText,
            participation
          };
        } catch (e) {
          return null;
        }
      }).filter(Boolean);
    });

    // Filter out items with "Individual Participation"
    const filtered = items.filter(i => i && (!i.participation || !/Individual Participation/i.test(i.participation)));

    // dedupe by href or title
    const unique = [];
    const seen = new Set();
    for (const it of filtered) {
      const key = (it.href || it.title || '').trim();
      if (!key) continue;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(it);
    }

    // write results
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(unique, null, 2), 'utf8');
    console.log(`Saved ${unique.length} hackathons to ${OUTPUT_FILE}`);
    await browser.close();
  } catch (err) {
    await browser.close();
    console.error('Crawler failed:', err);
    process.exitCode = 1;
  }
}

retry(run, 3, 1500).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
