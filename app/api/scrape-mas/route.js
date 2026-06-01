// app/api/scrape-mas/route.js
// Scrapes MAS T-Bill auction results using Browserless
// Uses the Download CSV button for reliable data extraction

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

    const now = new Date();
    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Set date range: 2 years back to now to ensure we get all recent auctions
    const twoYearsAgo = new Date(now);
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const startYear = twoYearsAgo.getFullYear().toString();
    const startMonth = MONTHS[twoYearsAgo.getMonth()];
    const endYear = now.getFullYear().toString();
    const endMonth = MONTHS[now.getMonth()];

    const result = await browserlessRequest(`
      export default async function ({ page }) {
        // Intercept the download request to capture CSV data
        let csvData = null;

        await page.setRequestInterception(true);

        page.on('request', req => {
          req.continue();
        });

        page.on('response', async res => {
          const ct = res.headers()['content-type'] || '';
          const cd = res.headers()['content-disposition'] || '';
          if (ct.includes('text/csv') || ct.includes('application/csv') ||
              ct.includes('application/octet-stream') || cd.includes('.csv') ||
              cd.includes('attachment')) {
            try {
              csvData = await res.text();
            } catch(e) {}
          }
        });

        await page.goto('https://eservices.mas.gov.sg/statistics/fdanet/BondTreasuryBillsCMTBsAuctions.aspx', {
          waitUntil: 'networkidle2',
          timeout: 30000,
        });

        await page.waitForSelector('#ContentPlaceHolder1_StartYearDropDownList', { timeout: 10000 });

        // Uncheck all product checkboxes
        for (const id of [
          'ContentPlaceHolder1_SGSBondsCheckBox',
          'ContentPlaceHolder1_SGSBondsMasCheckBoxList_0',
          'ContentPlaceHolder1_SGSBondsMasCheckBoxList_1',
          'ContentPlaceHolder1_SGSBondsMasCheckBoxList_2',
          'ContentPlaceHolder1_TBillsAndCMTBsCheckBox',
          'ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_0',
          'ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_1',
        ]) {
          const el = await page.$('#' + id);
          if (el) {
            const checked = await page.evaluate(e => e.checked, el);
            if (checked) await el.click();
            await new Promise(r => setTimeout(r, 100));
          }
        }

        // Check T-bills only
        await page.click('#ContentPlaceHolder1_TBillsAndCMTBsCheckBoxList_0');
        await new Promise(r => setTimeout(r, 300));

        // Set date range
        await page.select('#ContentPlaceHolder1_StartYearDropDownList', '${startYear}');
        await page.select('#ContentPlaceHolder1_EndYearDropDownList', '${endYear}');
        await page.select('#ContentPlaceHolder1_StartMonthDropDownList', '${startMonth}');
        await page.select('#ContentPlaceHolder1_EndMonthDropDownList', '${endMonth}');
        try { await page.select('#ContentPlaceHolder1_TermToMaturityAtAuctionTBillsDropDownList', 'All'); } catch(e) {}

        // Select all useful columns
        for (let i = 0; i <= 16; i++) {
          const el = await page.$('#ContentPlaceHolder1_SelectedColumnsCheckBoxList_' + i);
          if (el) {
            const checked = await page.evaluate(e => e.checked, el);
            if (checked) await el.click();
            await new Promise(r => setTimeout(r, 50));
          }
        }
        for (const i of [3, 6, 7, 11, 12]) {
          const el = await page.$('#ContentPlaceHolder1_SelectedColumnsCheckBoxList_' + i);
          if (el) { await el.click(); await new Promise(r => setTimeout(r, 100)); }
        }

        // Click Display first to load results
        await page.evaluate(() => {
          document.getElementById('ContentPlaceHolder1_DisplayButton').click();
        });

        try {
          await page.waitForFunction(
            () => Array.from(document.querySelectorAll('table')).some(t => t.querySelectorAll('tr').length > 3),
            { timeout: 15000 }
          );
        } catch(e) {}

        await new Promise(r => setTimeout(r, 2000));

        // Now click Download button to get CSV
        await page.evaluate(() => {
          const btn = document.getElementById('ContentPlaceHolder1_DownloadButton');
          if (btn) btn.click();
        });

        await new Promise(r => setTimeout(r, 5000));

        // Also grab table data as fallback
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

        return { tableData, csvData };
      }
    `);

    const csvData = result?.csvData;
    const tableRows = result?.tableData || [];

    // Parse CSV if available
    if (csvData && csvData.length > 100) {
      console.log('Got CSV data, length:', csvData.length);
      const lines = csvData.split('\n').filter(l => l.trim());
      const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const auctions = [];
      let headers = [];

      for (const line of lines) {
        const cells = line.split(',').map(c => c.replace(/^"|"$/g, '').trim());
        if (cells.length < 3) continue;

        if (headers.length === 0 && cells.some(c => /issue.?date|cut.?off/i.test(c))) {
          headers = cells.map(c => c.toLowerCase());
          continue;
        }

        if (headers.length === 0) continue;

        const issueDateIdx = headers.findIndex(h => /issue.?date/.test(h));
        const maturityIdx = headers.findIndex(h => /maturity.?date/.test(h));
        const yieldIdx = headers.findIndex(h => /cut.?off yield/.test(h));
        const priceIdx = headers.findIndex(h => /cut.?off price/.test(h));
        const termIdx = headers.findIndex(h => /term|tenor/.test(h));

        const issueDate = issueDateIdx >= 0 ? cells[issueDateIdx] : null;
        const maturityDate = maturityIdx >= 0 ? cells[maturityIdx] : null;
        const yieldVal = yieldIdx >= 0 ? cells[yieldIdx] : null;
        const price = priceIdx >= 0 ? cells[priceIdx] : null;
        const termDays = termIdx >= 0 ? cells[termIdx] : cells[0];

        if (!issueDate || !yieldVal) continue;

        let formattedDate = issueDate;
        if (/\d{2}\/\d{2}\/\d{4}/.test(issueDate)) {
          const [d, m, y] = issueDate.split('/');
          formattedDate = d + ' ' + MONTH_NAMES[parseInt(m) - 1] + ' ' + y;
        }

        let formattedMaturity = maturityDate;
        if (maturityDate && /\d{2}\/\d{2}\/\d{4}/.test(maturityDate)) {
          const [d, m, y] = maturityDate.split('/');
          formattedMaturity = d + ' ' + MONTH_NAMES[parseInt(m) - 1] + ' ' + y;
        }

        const days = parseInt(termDays) || 182;
        const tenor = days >= 350 ? '1-year' : '6-month';

        auctions.push({
          auction_date: formattedDate,
          tenor,
          cutoff_yield: parseFloat(yieldVal).toFixed(2) + '%',
          cutoff_price: price || null,
          maturity_date: formattedMaturity || null,
        });
      }

      if (auctions.length > 0) {
        const saved = await saveAuctions(supabase, auctions);
        return Response.json({
          success: true,
          source: 'csv',
          scraped: auctions.length,
          saved,
          sample: auctions.slice(-5), // last 5 = most recent
        });
      }
    }

    // Fallback: parse table rows (same logic as before)
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const auctions = [];
    let headerFound = false;
    let colMap = {};

    for (const row of tableRows) {
      const cells = row.cells || [];
      if (cells.length < 2) continue;
      const normCells = cells.map(c => c.replace(/\n/g, ' ').trim());

      if (!headerFound && normCells.some(c => /cut.off yield|issue.?date/i.test(c))) {
        headerFound = true;
        normCells.forEach((c, i) => {
          const norm = c.toLowerCase();
          if (/issue.?date/.test(norm)) colMap.issueDate = i;
          if (/maturity.?date/.test(norm)) colMap.maturityDate = i;
          if (/cut.off yield/.test(norm)) colMap.yield = i;
          if (/cut.off price/.test(norm)) colMap.price = i;
          if (/term|tenor/.test(norm)) colMap.term = i;
        });
        continue;
      }

      if (!headerFound) continue;
      if (normCells[0] === 'Bond Auction Results') continue;

      const issueDate = colMap.issueDate !== undefined ? normCells[colMap.issueDate] : normCells.find(c => /\d{2}\/\d{2}\/\d{4}/.test(c));
      const maturityDate = colMap.maturityDate !== undefined ? normCells[colMap.maturityDate] : null;
      const yieldVal = colMap.yield !== undefined ? normCells[colMap.yield] : normCells.find(c => /^\d+\.\d{2,4}$/.test(c) && parseFloat(c) < 15 && parseFloat(c) > 0);
      const price = colMap.price !== undefined ? normCells[colMap.price] : normCells.find(c => /^9[5-9]\.\d+$/.test(c));
      const termDays = colMap.term !== undefined ? normCells[colMap.term] : normCells[0];

      if (!issueDate || !yieldVal) continue;
      if (!/\d{2}\/\d{2}\/\d{4}/.test(issueDate)) continue;

      const [day, month, year] = issueDate.split('/');
      const formattedDate = day + ' ' + MONTH_NAMES[parseInt(month) - 1] + ' ' + year;

      let formattedMaturity = null;
      if (maturityDate && /\d{2}\/\d{2}\/\d{4}/.test(maturityDate)) {
        const [md, mm, my] = maturityDate.split('/');
        formattedMaturity = md + ' ' + MONTH_NAMES[parseInt(mm) - 1] + ' ' + my;
      }

      const days = parseInt(termDays) || 0;
      const tenor = days >= 350 ? '1-year' : '6-month';

      auctions.push({
        auction_date: formattedDate,
        tenor,
        cutoff_yield: parseFloat(yieldVal).toFixed(2) + '%',
        cutoff_price: price || null,
        maturity_date: formattedMaturity,
      });
    }

    if (auctions.length === 0) {
      return Response.json({
        success: false,
        message: 'Could not parse auction data.',
        rowCount: tableRows.length,
        csvLength: csvData ? csvData.length : 0,
      });
    }

    const saved = await saveAuctions(supabase, auctions);
    return Response.json({
      success: true,
      source: 'table',
      scraped: auctions.length,
      saved,
      sample: auctions.slice(-5),
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}