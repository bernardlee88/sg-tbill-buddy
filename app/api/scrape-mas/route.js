// app/api/scrape-mas/route.js
// Scrapes MAS T-Bill auction results using Browserless
// ASP.NET WebForms page — uses proper form submission with waitForNavigation

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

        // Step 1 — Uncheck all product checkboxes
        const allProductIds = [
          'ContentPlaceHolder1_SGSBondsCheckBox',
          'ContentPlaceHolder1_SGSBondsMasCheckBoxList_0',
          'ContentPlaceHolder1_SGSBondsMasCheckBoxList_1',
          'ContentPlaceHolder1_SGSBondsMasCheckBoxList_2',
          'ContentPlaceHolder1_TBillsAndCMTBsCheckBox',
          'ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_0',
          'ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_1',
        ];
        for (const id of allProductIds) {
          const el = await page.$('#' + id);
          if (el) {
            const checked = await page.evaluate(e => e.checked, el);
            if (checked) await el.click();
          }
        }

        await new Promise(r => setTimeout(r, 500));

        // Step 2 — Check T-bills only
        await page.click('#ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_0');
        await new Promise(r => setTimeout(r, 500));

        // Step 3 — Set date range
        await page.select('#ContentPlaceHolder1_StartYearDropDownList', '${startYear}');
        await page.select('#ContentPlaceHolder1_EndYearDropDownList', '${currentYear}');
        await page.select('#ContentPlaceHolder1_StartMonthDropDownList', 'Jan');
        await page.select('#ContentPlaceHolder1_EndMonthDropDownList', 'Dec');

        // Step 4 — Set tenor to All
        try {
          await page.select('#ContentPlaceHolder1_TermToMaturityAtAuctionTBillsDropDownList', 'All');
        } catch(e) {}

        // Step 5 — Select columns: Term(3), Issue Date(6), Maturity Date(7), Cut-off Yield(11), Cut-off Price(12)
        for (let i = 0; i <= 16; i++) {
          const el = await page.$('#ContentPlaceHolder1_SelectedColumnsCheckBoxList_' + i);
          if (el) {
            const checked = await page.evaluate(e => e.checked, el);
            if (checked) await el.click();
          }
        }
        await new Promise(r => setTimeout(r, 300));

        for (const i of [3, 6, 7, 11, 12]) {
          const el = await page.$('#ContentPlaceHolder1_SelectedColumnsCheckBoxList_' + i);
          if (el) await el.click();
        }
        await new Promise(r => setTimeout(r, 300));

        // Step 6 — Click Display and wait for page reload (ASP.NET postback)
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }),
          page.click('#ContentPlaceHolder1_DisplayButton'),
        ]);

        // Step 7 — Extract table
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
    console.log('Got', rows.length, 'rows from MAS');

    // Parse rows — detect header then extract data
    const auctions = [];
    let headerFound = false;
    let colMap = {};

    for (const row of rows) {
      const cells = row.cells || [];
      if (cells.length < 2) continue;

      // Detect header row
      if (!headerFound && cells.some(c => /cut.off yield|issue date/i.test(c))) {
        headerFound = true;
        cells.forEach((c, i) => {
          const norm = c.toLowerCase();
          if (/issue date/.test(norm)) colMap.issueDate = i;
          if (/maturity date/.test(norm)) colMap.maturityDate = i;
          if (/cut.off yield/.test(norm)) colMap.yield = i;
          if (/cut.off price/.test(norm)) colMap.price = i;
          if (/term|tenor/.test(norm)) colMap.tenor = i;
        });
        continue;
      }

      if (!headerFound) continue;

      const issueDate = colMap.issueDate !== undefined ? cells[colMap.issueDate] : cells.find(c => /\d{1,2}\s+\w{3}\s+\d{4}/.test(c));
      const maturityDate = colMap.maturityDate !== undefined ? cells[colMap.maturityDate] : null;
      const yieldVal = colMap.yield !== undefined ? cells[colMap.yield] : cells.find(c => /^\d+\.\d{2,4}$/.test(c) && parseFloat(c) < 15 && parseFloat(c) > 0);
      const price = colMap.price !== undefined ? cells[colMap.price] : cells.find(c => /^9[5-9]\.\d+$/.test(c));
      const tenorCell = colMap.tenor !== undefined ? cells[colMap.tenor] : '';

      if (!issueDate || !yieldVal) continue;

      const tenor = /1.year|1-year|364|1 year/i.test(tenorCell + cells.join(' ')) ? '1-year' : '6-month';

      auctions.push({
        auction_date: issueDate.trim(),
        tenor,
        cutoff_yield: parseFloat(yieldVal).toFixed(2) + '%',
        cutoff_price: price || null,
        maturity_date: maturityDate ? maturityDate.trim() : null,
      });
    }

    console.log('Parsed', auctions.length, 'auction records');

    if (auctions.length === 0) {
      return Response.json({
        success: false,
        message: 'Could not parse auction data.',
        rowCount: rows.length,
        sampleRows: rows.slice(0, 20),
        pageTextPreview: result?.pageText?.slice(0, 1000),
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