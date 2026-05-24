// app/api/scrape-mas/route.js
// Scrapes MAS T-Bill auction results using Browserless

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

export async function GET(request) {
  if (!isAuthorised(request)) {
    return Response.json({ error: 'Unauthorised' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;

  // Debug env vars
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

  // Raw HTML mode — see what MAS page actually looks like
  if (params.get('raw') === '1') {
    try {
      const result = await browserlessRequest(`
        export default async function ({ page }) {
          await page.goto('https://eservices.mas.gov.sg/statistics/fdanet/BondTreasuryBillsCMTBsAuctions.aspx', {
            waitUntil: 'networkidle2',
            timeout: 30000,
          });
          const html = await page.content();
          const text = await page.evaluate(() => document.body.innerText);
          const tables = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('table')).map(t => t.outerHTML.slice(0, 500));
          });
          const selects = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('select')).map(s => ({
              id: s.id, name: s.name,
              options: Array.from(s.options).map(o => o.text)
            }));
          });
          const title = await page.title();
          return { title, textPreview: text.slice(0, 1000), tableCount: tables.length, tables: tables.slice(0, 3), selects };
        }
      `);
      return Response.json({ raw: result });
    } catch (err) {
      return Response.json({ error: err.message });
    }
  }

  try {
    const supabase = getSupabaseClient();

    // Scrape MAS auction page
    const result = await browserlessRequest(`
      export default async function ({ page }) {
        await page.goto('https://eservices.mas.gov.sg/statistics/fdanet/BondTreasuryBillsCMTBsAuctions.aspx', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });

        await new Promise(r => setTimeout(r, 2000));

        // Get all table data
        const tableData = await page.evaluate(() => {
          const results = [];
          const tables = document.querySelectorAll('table');

          tables.forEach((table, tIdx) => {
            const rows = Array.from(table.querySelectorAll('tr'));
            rows.forEach((row, rIdx) => {
              const cells = Array.from(row.querySelectorAll('th, td')).map(c => c.innerText.trim());
              if (cells.length > 0) {
                results.push({ tableIdx: tIdx, rowIdx: rIdx, cells });
              }
            });
          });

          return results;
        });

        return { tableData };
      }
    `);

    const rows = result?.tableData || [];
    console.log('Got', rows.length, 'rows from MAS page');

    // Parse rows into auction records
    const auctions = [];
    for (const row of rows) {
      const cells = row.cells || [];
      if (cells.length < 3) continue;

      // Look for rows containing a date and a yield-like number
      const dateMatch = cells.find(c => /\d{1,2}\s+\w{3}\s+\d{4}|\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/.test(c));
      const yieldMatch = cells.find(c => /^\d+\.\d{2,4}$/.test(c) && parseFloat(c) < 15 && parseFloat(c) > 0);
      const priceMatch = cells.find(c => /^9[5-9]\.\d+$/.test(c));

      if (!dateMatch || !yieldMatch) continue;

      // Determine tenor from cells
      const allText = cells.join(' ').toLowerCase();
      const tenor = /1.year|1-year|364|12.month/.test(allText) ? '1-year' : '6-month';

      auctions.push({
        auction_date: dateMatch.trim(),
        tenor,
        cutoff_yield: parseFloat(yieldMatch).toFixed(2) + '%',
        cutoff_price: priceMatch || null,
        maturity_date: null,
      });
    }

    console.log('Parsed', auctions.length, 'auction records');

    if (auctions.length === 0) {
      return Response.json({
        success: false,
        message: 'Could not parse any auction data. Run with ?raw=1 to inspect the page.',
        rowCount: rows.length,
        sampleRows: rows.slice(0, 5),
      });
    }

    const saved = await saveAuctions(supabase, auctions);

    return Response.json({
      success: true,
      scraped: auctions.length,
      saved,
      sample: auctions.slice(0, 5),
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}