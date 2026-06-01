// app/api/scrape-mas/route.js
// Scrapes T-Bill auction results from Growbeansprout
// Growbeansprout publishes every MAS T-bill result reliably after each auction
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
    else console.error('Upsert error for', auction.auction_date, ':', error.message);
  }
  return saved;
}

// Calculate cut-off price from yield and tenor days
function calcCutoffPrice(yieldPct, tenorDays) {
  const y = parseFloat(yieldPct) / 100;
  const t = parseInt(tenorDays);
  if (isNaN(y) || isNaN(t) || y <= 0) return null;
  const price = 100 - (100 * y * t / 365);
  return price.toFixed(3);
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

    // Step 1 — Scrape Growbeansprout T-bill results page
    const result = await browserlessRequest(`
      export default async function ({ page }) {
        await page.goto('https://growbeansprout.com/singapore-t-bill-cut-off-yield', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });

        await new Promise(r => setTimeout(r, 2000));

        // Extract all text content and any tables
        const pageText = await page.evaluate(() => document.body.innerText);

        const tableData = await page.evaluate(() => {
          const results = [];
          document.querySelectorAll('table').forEach((table, tIdx) => {
            table.querySelectorAll('tr').forEach((row, rIdx) => {
              const cells = Array.from(row.querySelectorAll('th, td')).map(c => c.innerText.trim());
              if (cells.length > 0) results.push({ tableIdx: tIdx, rowIdx: rIdx, cells });
            });
          });
          return results;
        });

        return { pageText: pageText.slice(0, 5000), tableData };
      }
    `);

    const pageText = result?.pageText || '';
    const tableRows = result?.tableData || [];

    console.log('Growbeansprout page text length:', pageText.length);
    console.log('Table rows:', tableRows.length);

    const auctions = [];
    const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Parse table rows if available
    if (tableRows.length > 0) {
      let headerFound = false;
      let colMap = {};

      for (const row of tableRows) {
        const cells = row.cells || [];
        if (cells.length < 2) continue;
        const normCells = cells.map(c => c.replace(/\n/g, ' ').trim());

        if (!headerFound && normCells.some(c => /date|yield|tenor/i.test(c))) {
          headerFound = true;
          normCells.forEach((c, i) => {
            const norm = c.toLowerCase();
            if (/date/.test(norm)) colMap.date = i;
            if (/yield/.test(norm)) colMap.yield = i;
            if (/tenor|type|month/.test(norm)) colMap.tenor = i;
          });
          continue;
        }

        if (!headerFound) continue;

        const dateCell = colMap.date !== undefined ? normCells[colMap.date] : normCells.find(c => /\d{1,2}[\s\/]\w+[\s\/]\d{4}|\d{2}\/\d{2}\/\d{4}/.test(c));
        const yieldCell = colMap.yield !== undefined ? normCells[colMap.yield] : normCells.find(c => /^\d+\.\d+%?$/.test(c) && parseFloat(c) < 15);
        const tenorCell = colMap.tenor !== undefined ? normCells[colMap.tenor] : '';

        if (!dateCell || !yieldCell) continue;

        const yieldVal = parseFloat(yieldCell.replace('%', ''));
        if (isNaN(yieldVal) || yieldVal <= 0) continue;

        const tenor = /1.year|1-year|12.month|364/i.test(tenorCell + normCells.join(' ')) ? '1-year' : '6-month';
        const tenorDays = tenor === '1-year' ? 364 : 182;
        const price = calcCutoffPrice(yieldVal, tenorDays);

        auctions.push({
          auction_date: dateCell.trim(),
          tenor,
          cutoff_yield: yieldVal.toFixed(2) + '%',
          cutoff_price: price,
          maturity_date: null,
        });
      }
    }

    // Parse from page text using regex if table parsing got nothing
    if (auctions.length === 0) {
      // Match patterns like "21 May 2026" or "21 May" followed by a yield like "1.45%"
      const pattern = /(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})[^\n]*?([\d.]+)%/gi;
      let match;
      while ((match = pattern.exec(pageText)) !== null) {
        const day = match[1].padStart(2, '0');
        const month = match[2];
        const year = match[3];
        const yieldVal = parseFloat(match[4]);

        if (yieldVal <= 0 || yieldVal >= 15) continue;

        const dateStr = day + ' ' + month + ' ' + year;
        const contextAround = pageText.slice(Math.max(0, match.index - 50), match.index + 100).toLowerCase();
        const tenor = /1.year|1-year|364|one year/i.test(contextAround) ? '1-year' : '6-month';
        const tenorDays = tenor === '1-year' ? 364 : 182;

        auctions.push({
          auction_date: dateStr,
          tenor,
          cutoff_yield: yieldVal.toFixed(2) + '%',
          cutoff_price: calcCutoffPrice(yieldVal, tenorDays),
          maturity_date: null,
        });
      }
    }

    // Deduplicate
    const seen = new Set();
    const unique = auctions.filter(a => {
      const key = a.auction_date + '|' + a.tenor;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    console.log('Parsed', unique.length, 'auctions from Growbeansprout');

    if (unique.length === 0) {
      // If Growbeansprout page structure changed, fall back to MAS eServices
      return Response.json({
        success: false,
        message: 'Could not parse from Growbeansprout. Page may have changed structure.',
        pageTextPreview: pageText.slice(0, 500),
        tableRows: tableRows.slice(0, 5),
      });
    }

    const saved = await saveAuctions(supabase, unique);

    return Response.json({
      success: true,
      source: 'growbeansprout',
      scraped: unique.length,
      saved,
      sample: unique.slice(0, 5),
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}