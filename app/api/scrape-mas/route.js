// app/api/scrape-mas/route.js
// Scrapes MAS T-Bill auction results using Browserless
// Uses exact checkbox IDs from MAS SGS Auction Result page

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
    const currentYear = new Date().getFullYear().toString();
    const startYear = (new Date().getFullYear() - 1).toString();

    const result = await browserlessRequest(`
      export default async function ({ page }) {
        await page.goto('https://eservices.mas.gov.sg/statistics/fdanet/BondTreasuryBillsCMTBsAuctions.aspx', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });

        await page.waitForSelector('#ContentPlaceHolder1_StartYearDropDownList', { timeout: 10000 });

        // Step 1 — Uncheck all product type checkboxes first
        await page.evaluate(() => {
          const allProductCheckboxes = [
            'ContentPlaceHolder1_SGSBondsCheckBox',
            'ContentPlaceHolder1_SGSBondsMasCheckBoxList_0',
            'ContentPlaceHolder1_SGSBondsMasCheckBoxList_1',
            'ContentPlaceHolder1_SGSBondsMasCheckBoxList_2',
            'ContentPlaceHolder1_TBillsAndCMTBsCheckBox',
            'ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_0',
            'ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_1',
          ];
          allProductCheckboxes.forEach(id => {
            const el = document.getElementById(id);
            if (el && el.checked) {
              el.checked = false;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
        });

        await new Promise(r => setTimeout(r, 300));

        // Step 2 — Check only T-bills
        await page.evaluate(() => {
          const tbills = document.getElementById('ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_0');
          if (tbills) {
            tbills.checked = true;
            tbills.dispatchEvent(new Event('change', { bubbles: true }));
            tbills.click();
          }
        });

        await new Promise(r => setTimeout(r, 300));

        // Step 3 — Set date range
        await page.select('#ContentPlaceHolder1_StartYearDropDownList', '${startYear}');
        await page.select('#ContentPlaceHolder1_EndYearDropDownList', '${currentYear}');
        await page.select('#ContentPlaceHolder1_StartMonthDropDownList', 'Jan');
        await page.select('#ContentPlaceHolder1_EndMonthDropDownList', 'Dec');

        // Step 4 — Set tenor to All
        try {
          await page.select('#ContentPlaceHolder1_TermToMaturityAtAuctionTBillsDropDownList', 'All');
        } catch(e) {}

        // Step 5 — Select columns to display
        // We want: Term to Maturity (3), Issue Date (6), Maturity Date (7), Cut-off Yield (11), Cut-off Price (12)
        const columnsToCheck = [3, 6, 7, 11, 12];
        await page.evaluate((cols) => {
          // First uncheck all column checkboxes
          for (let i = 0; i <= 16; i++) {
            const el = document.getElementById('ContentPlaceHolder1_SelectedColumnsCheckBoxList_' + i);
            if (el) el.checked = false;
          }
          // Then check only the ones we want
          cols.forEach(i => {
            const el = document.getElementById('ContentPlaceHolder1_SelectedColumnsCheckBoxList_' + i);
            if (el) {
              el.checked = true;
              el.dispatchEvent(new Event('change', { bubbles: true }));
            }
          });
        }, columnsToCheck);

        await new Promise(r => setTimeout(r, 300));

        // Step 6 — Click Display button
        await page.click('#ContentPlaceHolder1_DisplayButton');
        console.log('Clicked Display button');

        // Step 7 — Wait for results to load
        await new Promise(r => setTimeout(r, 6000));

        // Step 8 — Extract table data
        const tableData = await page.evaluate(() => {
          const results = [];
          const tables = document.querySelectorAll('table');
          tables.forEach((table, tIdx) => {
            const rows = Array.from(table.querySelectorAll('tr'));
            rows.forEach((row, rIdx) => {
              const cells = Array.from(row.querySelectorAll('th, td')).map(c => c.innerText.trim());
              if (cells.length > 0) results.push({ tableIdx: tIdx, rowIdx: rIdx, cells });
            });
          });
          return results;
        });

        const pageText = await page.evaluate(() => document.body.innerText.slice(800, 3000));

        return { tableData, pageText };
      }
    `);

    const rows = result?.tableData || [];
    const pageText = result?.pageText || '';
    console.log('Got', rows.length, 'rows from MAS');

    // Parse rows — columns are: Term, Issue Date, Maturity Date, Cut-off Yield, Cut-off Price
    const auctions = [];
    let headerFound = false;
    let colMap = {};

    for (const row of rows) {
      const cells = row.cells || [];
      if (cells.length < 3) continue;

      // Detect header row to build column map
      if (!headerFound && cells.some(c => /cut.off yield|issue date|maturity/i.test(c))) {
        headerFound = true;
        cells.forEach((c, i) => {
          const norm = c.toLowerCase();
          if (/issue date/.test(norm)) colMap.issueDate = i;
          if (/maturity date/.test(norm)) colMap.maturityDate = i;
          if (/cut.off yield/.test(norm)) colMap.yield = i;
          if (/cut.off price/.test(norm)) colMap.price = i;
          if (/term|tenor|maturity at auction/.test(norm)) colMap.tenor = i;
        });
        console.log('Column map:', JSON.stringify(colMap));
        continue;
      }

      if (!headerFound) continue;
      if (cells.length < 3) continue;

      // Extract using column map if available, else fall back to pattern matching
      let issueDate, maturityDate, yieldVal, price, tenor;

      if (Object.keys(colMap).length > 0) {
        issueDate = colMap.issueDate !== undefined ? cells[colMap.issueDate] : null;
        maturityDate = colMap.maturityDate !== undefined ? cells[colMap.maturityDate] : null;
        yieldVal = colMap.yield !== undefined ? cells[colMap.yield] : null;
        price = colMap.price !== undefined ? cells[colMap.price] : null;
        tenor = colMap.tenor !== undefined ? cells[colMap.tenor] : null;
      } else {
        issueDate = cells.find(c => /\d{1,2}\s+\w{3}\s+\d{4}|\d{2}\/\d{2}\/\d{4}/.test(c));
        yieldVal = cells.find(c => /^\d+\.\d{2,4}$/.test(c) && parseFloat(c) < 15 && parseFloat(c) > 0);
        price = cells.find(c => /^9[5-9]\.\d+$/.test(c));
        tenor = cells.find(c => /6.month|6-month|1.year|1-year|182|364/i.test(c));
      }

      if (!issueDate || !yieldVal) continue;

      const tenorStr = tenor && /1.year|1-year|364|12.month|1 year/i.test(tenor) ? '1-year' : '6-month';

      auctions.push({
        auction_date: issueDate.trim(),
        tenor: tenorStr,
        cutoff_yield: parseFloat(yieldVal).toFixed(2) + '%',
        cutoff_price: price || null,
        maturity_date: maturityDate || null,
      });
    }

    console.log('Parsed', auctions.length, 'auction records');

    if (auctions.length === 0) {
      return Response.json({
        success: false,
        message: 'Could not parse auction data.',
        rowCount: rows.length,
        sampleRows: rows.slice(0, 15),
        pageTextPreview: pageText,
        colMap,
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