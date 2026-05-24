// app/api/scrape-mas/route.js
// Scrapes MAS T-Bill auction results using Browserless
// Runs every Thursday at 6pm SGT via Vercel cron
// Saves results to Supabase tbill_auctions table

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

// Scrape MAS auction page using Browserless
async function scrapeMASAuctions() {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) throw new Error('Missing BROWSERLESS_API_KEY');

  const scrapeScript = `
    export default async function ({ page }) {
      await page.goto('https://eservices.mas.gov.sg/statistics/fdanet/TreasuryBillAuctions.aspx', {
        waitUntil: 'networkidle2',
        timeout: 30000,
      });

      // Wait for the table to load
      await page.waitForSelector('table', { timeout: 15000 }).catch(() => {});

      // Extract table data
      const data = await page.evaluate(() => {
        const results = [];
        const tables = document.querySelectorAll('table');

        tables.forEach(table => {
          const rows = table.querySelectorAll('tr');
          let headers = [];

          rows.forEach((row, rowIndex) => {
            const cells = row.querySelectorAll('th, td');
            const cellTexts = Array.from(cells).map(c => c.innerText.trim());

            if (rowIndex === 0 || cellTexts.some(t => t.toLowerCase().includes('date') || t.toLowerCase().includes('yield'))) {
              headers = cellTexts;
            } else if (cellTexts.length >= 3 && cellTexts[0].match(/\\d{2}\\s+\\w+\\s+\\d{4}|\\.+/)) {
              const row = {};
              headers.forEach((h, i) => { row[h] = cellTexts[i] || ''; });
              row['_raw'] = cellTexts;
              results.push(row);
            }
          });
        });

        return results;
      });

      return { data };
    }
  `;

  const res = await fetch(
    'https://chrome.browserless.io/function?token=' + apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: scrapeScript }),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Browserless error: ' + res.status + ' — ' + errText);
  }

  const result = await res.json();
  return result?.data || [];
}

// Parse raw scraped rows into clean auction records
function parseAuctionRows(rows) {
  const auctions = [];

  for (const row of rows) {
    const raw = row._raw || Object.values(row);
    if (!raw || raw.length < 3) continue;

    // Try to find date, tenor, yield from the raw cells
    const dateMatch = raw.find(v => /\d{2}\s+\w+\s+\d{4}/.test(v));
    const yieldMatch = raw.find(v => /^\d+\.\d+$/.test(v) && parseFloat(v) < 20);
    const priceMatch = raw.find(v => /^9[5-9]\.\d+$/.test(v));
    const tenorMatch = raw.find(v => /6.month|6-month|182|1.year|1-year|364/i.test(v));

    if (!dateMatch || !yieldMatch) continue;

    let tenor = '6-month';
    if (tenorMatch) {
      if (/1.year|1-year|364/i.test(tenorMatch)) tenor = '1-year';
    }

    auctions.push({
      auction_date: dateMatch.trim(),
      tenor,
      cutoff_yield: yieldMatch.trim() + '%',
      cutoff_price: priceMatch ? priceMatch.trim() : null,
      maturity_date: null,
    });
  }

  return auctions;
}

// Alternative: scrape the structured MAS page with known layout
async function scrapeMASStructured() {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) throw new Error('Missing BROWSERLESS_API_KEY');

  const scrapeScript = `
    export default async function ({ page }) {
      await page.goto(
        'https://eservices.mas.gov.sg/statistics/fdanet/BondTreasuryBillsCMTBsAuctions.aspx',
        { waitUntil: 'networkidle2', timeout: 30000 }
      );

      // Select T-bills filter if available
      try {
        await page.select('select[name*="ProductType"], select[id*="ProductType"]', 'T-bills');
        await page.waitForTimeout(2000);
      } catch(e) {}

      const auctions = await page.evaluate(() => {
        const results = [];
        const rows = document.querySelectorAll('table tr');

        rows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td'));
          if (cells.length < 4) return;

          const texts = cells.map(c => c.innerText.trim());

          // Look for rows with date pattern and yield
          const hasDate = texts.some(t => /\\d{2}[\\s\\/\\-]\\w+[\\s\\/\\-]\\d{4}|\\d{4}-\\d{2}-\\d{2}/.test(t));
          const hasYield = texts.some(t => /^\\d+\\.\\d+$/.test(t) && parseFloat(t) < 10);

          if (hasDate && hasYield) {
            results.push(texts);
          }
        });

        return results;
      });

      return { auctions };
    }
  `;

  const res = await fetch(
    'https://chrome.browserless.io/function?token=' + apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: scrapeScript }),
    }
  );

  if (!res.ok) throw new Error('Browserless error: ' + res.status);
  const result = await res.json();
  return result?.auctions || [];
}

// Save auctions to Supabase
async function saveAuctions(supabase, auctions) {
  if (auctions.length === 0) return 0;

  let saved = 0;
  for (const auction of auctions) {
    const { error } = await supabase
      .from('tbill_auctions')
      .upsert(
        {
          auction_date: auction.auction_date,
          tenor: auction.tenor,
          cutoff_yield: auction.cutoff_yield,
          cutoff_price: auction.cutoff_price,
          maturity_date: auction.maturity_date,
          scraped_at: new Date().toISOString(),
        },
        { onConflict: 'auction_date,tenor' }
      );

    if (!error) saved++;
    else console.error('Upsert error:', error.message);
  }
  return saved;
}

export async function GET(request) {
  if (!isAuthorised(request)) {
    return Response.json({ error: 'Unauthorised' }, { status: 401 });
  }

  // Debug mode — check env vars first
  const debug = new URL(request.url).searchParams.get('debug') === '1';
  if (debug) {
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
    console.log('Starting MAS T-Bill scrape...');

    let auctions = [];
    let parseError = null;

    // Try structured scrape first
    try {
      const rows = await scrapeMASStructured();
      console.log('Structured scrape returned', rows.length, 'rows');

      // Parse the raw rows
      for (const row of rows) {
        const dateMatch = row.find(v => /\d{2}[\s\/\-]\w+[\s\/\-]\d{4}|\d{4}-\d{2}-\d{2}/.test(v));
        const yieldMatch = row.find(v => /^\d+\.\d+$/.test(v) && parseFloat(v) < 10);
        const priceMatch = row.find(v => /^9[5-9]\.\d+$/.test(v));
        const isSixMonth = row.some(v => /6.month|6-month|182/i.test(v));
        const isOneYear = row.some(v => /1.year|1-year|364|12.month/i.test(v));

        if (dateMatch && yieldMatch) {
          auctions.push({
            auction_date: dateMatch.trim(),
            tenor: isOneYear ? '1-year' : '6-month',
            cutoff_yield: yieldMatch.trim() + '%',
            cutoff_price: priceMatch || null,
            maturity_date: null,
          });
        }
      }
    } catch (err) {
      parseError = err.message;
      console.error('Structured scrape failed:', err.message);
    }

    // Fallback to general scrape
    if (auctions.length === 0) {
      try {
        const rows = await scrapeMASAuctions();
        auctions = parseAuctionRows(rows);
      } catch (err) {
        console.error('General scrape also failed:', err.message);
      }
    }

    console.log('Parsed', auctions.length, 'auction records');

    if (auctions.length === 0) {
      return Response.json({
        success: false,
        message: 'Could not parse any auction data from MAS website',
        parseError,
      });
    }

    const saved = await saveAuctions(supabase, auctions);

    return Response.json({
      success: true,
      scraped: auctions.length,
      saved,
      auctions: auctions.slice(0, 5),
    });

  } catch (err) {
    console.error('Scrape MAS error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}