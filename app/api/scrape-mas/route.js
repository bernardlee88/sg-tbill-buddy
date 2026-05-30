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

        // Uncheck all product checkboxes
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
            await new Promise(r => setTimeout(r, 100));
          }
        }

        // Check T-bills only
        await page.click('#ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_0');
        await new Promise(r => setTimeout(r, 500));

        // Set date range
        await page.select('#ContentPlaceHolder1_StartYearDropDownList', '${startYear}');
        await page.select('#ContentPlaceHolder1_EndYearDropDownList', '${currentYear}');
        await page.select('#ContentPlaceHolder1_StartMonthDropDownList', 'Jan');
        await page.select('#ContentPlaceHolder1_EndMonthDropDownList', 'Dec');

        // Tenor to All
        try { await page.select('#ContentPlaceHolder1_TermToMaturityAtAuctionTBillsDropDownList', 'All'); } catch(e) {}

        // Uncheck all column checkboxes
        for (let i = 0; i <= 16; i++) {
          const el = await page.$('#ContentPlaceHolder1_SelectedColumnsCheckBoxList_' + i);
          if (el) {
            const checked = await page.evaluate(e => e.checked, el);
            if (checked) await el.click();
            await new Promise(r => setTimeout(r, 50));
          }
        }

        // Check only: Term(3), Issue Date(6), Maturity Date(7), Cut-off Yield(11), Cut-off Price(12)
        for (const i of [3, 6, 7, 11, 12]) {
          const el = await page.$('#ContentPlaceHolder1_SelectedColumnsCheckBoxList_' + i);
          if (el) await el.click();
          await new Promise(r => setTimeout(r, 100));
        }

        // Take screenshot before clicking to verify state
        const beforeState = await page.evaluate(() => {
          const tbill = document.getElementById('ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_0');
          const col11 = document.getElementById('ContentPlaceHolder1_SelectedColumnsCheckBoxList_11');
          return {
            tbillChecked: tbill ? tbill.checked : null,
            yieldColChecked: col11 ? col11.checked : null,
          };
        });
        console.log('Before click state:', JSON.stringify(beforeState));

        // Click Display — ASP.NET UpdatePanel uses partial postback
        // Use evaluate to directly submit form
        await page.evaluate(() => {
          const btn = document.getElementById('ContentPlaceHolder1_DisplayButton');
          if (btn) btn.click();
        });

        // Wait for UpdatePanel to complete (AJAX partial postback)
        await new Promise(r => setTimeout(r, 8000));

        // Extract all text and tables
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

        // Also get full page text to see what loaded
        const pageText = await page.evaluate(() => document.body.innerText);

        return { tableData, pageText: pageText.slice(800, 3000), beforeState };
      }
    `);

    const rows = result?.tableData || [];
    const pageText = result?.pageText || '';
    console.log('Rows:', rows.length, 'beforeState:', JSON.stringify(result?.beforeState));

    // Parse rows
    const auctions = [];
    let headerFound = false;
    let colMap = {};

    for (const row of rows) {
      const cells = row.cells || [];
      if (cells.length < 2) continue;

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
      const tenorCell = colMap.tenor !== undefined ? (cells[colMap.tenor] || '') : '';

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

    if (auctions.length === 0) {
      return Response.json({
        success: false,
        message: 'Could not parse auction data.',
        rowCount: rows.length,
        sampleRows: rows.slice(0, 20),
        pageTextPreview: pageText,
        colMap,
        beforeState: result?.beforeState,
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