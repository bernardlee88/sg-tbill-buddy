// app/api/scrape-mas/route.js
// Scrapes T-Bill auction results automatically
// Strategy: fetch individual Growbeansprout allotment articles + MAS eServices table
// Cron: every Thursday at 6pm SGT (10:00 UTC)

import { createClient } from '@supabase/supabase-js';

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Missing Supabase environment variables');
  return createClient(url, key);
}

function isAuthorised(request) {
  const authHeader = request.headers.get('authorization');
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return authHeader === 'Bearer ' + secret;
}

async function browserlessRequest(code) {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) throw new Error('Missing BROWSERLESS_API_KEY');
  const res = await fetch(
    'https://chrome.browserless.io/function?token=' + apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
    }
  );
  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Browserless error: ' + res.status + ' — ' + errText.slice(0, 200));
  }
  return res.json();
}

async function saveAuctions(supabase, auctions) {
  let saved = 0;
  for (const auction of auctions) {
    const { error } = await supabase
      .from('tbill_auctions')
      .upsert(
        {
          auction_date: auction.auction_date,
          tenor: auction.tenor,
          cutoff_yield: auction.cutoff_yield,
          cutoff_price: auction.cutoff_price || null,
          maturity_date: auction.maturity_date || null,
          scraped_at: new Date().toISOString(),
        },
        { onConflict: 'auction_date,tenor' }
      );
    if (!error) saved++;
    else console.error('Upsert error:', error.message);
  }
  return saved;
}

function calcCutoffPrice(yieldPct, tenorDays) {
  const y = parseFloat(yieldPct) / 100;
  const t = parseInt(tenorDays);
  if (isNaN(y) || isNaN(t) || y <= 0) return null;
  return (100 - 100 * y * t / 365).toFixed(3);
}

// Build Growbeansprout article URL for a given auction date
function buildGrowbeansproutUrl(dateStr) {
  // dateStr format: "21 May 2026"
  const parts = dateStr.split(' ');
  if (parts.length !== 3) return null;
  const day = parts[0];
  const month = parts[1].toLowerCase();
  const year = parts[2];
  return 'https://growbeansprout.com/t-bill-allotment-' + day + '-' + month + '-' + year;
}

// Generate a list of expected auction dates for the last 6 months
// T-bills auction every ~2 weeks on Thursdays
function getExpectedAuctionDates() {
  const dates = [];
  const now = new Date();
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  // Go back 6 months, check every Thursday
  const start = new Date(now);
  start.setMonth(start.getMonth() - 6);

  const d = new Date(start);
  // Move to next Thursday
  d.setDate(d.getDate() + (4 - d.getDay() + 7) % 7);

  while (d <= now) {
    const day = d.getDate().toString().padStart(2, '0');
    const month = MONTHS[d.getMonth()];
    const year = d.getFullYear();
    dates.push(day + ' ' + month + ' ' + year);
    d.setDate(d.getDate() + 14); // next auction ~2 weeks later
  }

  return dates;
}

export async function GET(request) {
  if (!isAuthorised(request)) {
    return Response.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;

  if (params.get('debug') === '1') {
    return Response.json({
      env: {
        BROWSERLESS_API_KEY: process.env.BROWSERLESS_API_KEY ? 'set (' + process.env.BROWSERLESS_API_KEY.slice(0, 8) + '...)' : 'MISSING',
        SUPABASE_URL: process.env.SUPABASE_URL ? 'set' : 'MISSING',
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'MISSING',
        CRON_SECRET: process.env.CRON_SECRET ? 'set' : 'MISSING',
      }
    });
  }

  try {
    const supabase = getSupabaseClient();

    // Get already saved auction dates to avoid re-scraping
    const { data: existing } = await supabase
      .from('tbill_auctions')
      .select('auction_date, tenor')
      .order('scraped_at', { ascending: false })
      .limit(50);

    const existingKeys = new Set((existing || []).map(r => r.auction_date + '|' + r.tenor));

    // Get expected auction dates for last 6 months
    const expectedDates = getExpectedAuctionDates();
    console.log('Checking', expectedDates.length, 'expected auction dates');

    // Find which ones we're missing
    const missing = expectedDates.filter(d =>
      !existingKeys.has(d + '|6-month') && !existingKeys.has(d + '|1-year')
    );

    console.log('Missing dates:', missing);

    if (missing.length === 0) {
      return Response.json({
        success: true,
        message: 'All recent auctions already in database',
        checked: expectedDates.length,
      });
    }

    // Scrape Growbeansprout articles for missing dates
    const allAuctions = [];

    for (const dateStr of missing.slice(0, 5)) { // max 5 per run
      const url = buildGrowbeansproutUrl(dateStr);
      if (!url) continue;

      console.log('Scraping:', url);

      try {
        const result = await browserlessRequest(`
          export default async function ({ page }) {
            await page.goto('${url}', {
              waitUntil: 'networkidle2',
              timeout: 20000,
            });

            const text = await page.evaluate(() => document.body.innerText.slice(0, 3000));
            const title = await page.title();
            return { text, title, url: '${url}' };
          }
        `);

        const text = result?.text || '';
        const title = result?.title || '';

        // Skip if page not found
        if (text.includes('Page not found') || text.includes('404')) {
          console.log('Page not found:', url);
          continue;
        }

        console.log('Page found:', title.slice(0, 80));

        // Extract yield from text — look for patterns like "1.45%" near the date
        const yieldMatch = text.match(/cut.off yield[^.]*?([\d.]+)%/i) ||
                           text.match(/([\d.]+)%[^.]*?cut.off yield/i) ||
                           text.match(/yield of ([\d.]+)%/i) ||
                           text.match(/([\d.]+)%\s+in the auction/i);

        if (!yieldMatch) {
          console.log('No yield found in:', url);
          continue;
        }

        const yieldVal = parseFloat(yieldMatch[1]);
        if (isNaN(yieldVal) || yieldVal <= 0 || yieldVal >= 15) continue;

        // Determine tenor from title/URL
        const tenor = /1.year|one.year|1-year|by\d/i.test(title + url) ? '1-year' : '6-month';
        const tenorDays = tenor === '1-year' ? 364 : 182;

        console.log('Found:', dateStr, tenor, yieldVal + '%');

        allAuctions.push({
          auction_date: dateStr,
          tenor,
          cutoff_yield: yieldVal.toFixed(2) + '%',
          cutoff_price: calcCutoffPrice(yieldVal, tenorDays),
          maturity_date: null,
        });

        await new Promise(r => setTimeout(r, 1000)); // polite delay

      } catch (err) {
        console.error('Error scraping', url, ':', err.message);
      }
    }

    if (allAuctions.length === 0) {
      return Response.json({
        success: false,
        message: 'No new auction data found. Checked ' + missing.length + ' dates.',
        missing,
        checked: expectedDates,
      });
    }

    const saved = await saveAuctions(supabase, allAuctions);

    return Response.json({
      success: true,
      source: 'growbeansprout',
      scraped: allAuctions.length,
      saved,
      sample: allAuctions,
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}