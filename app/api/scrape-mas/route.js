// app/api/scrape-mas/route.js
// Scrapes latest 12 months of MAS T-Bill auction results using Browserless

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

    // Calculate 8 months ago — narrow range ensures we get the most recent auctions
    // MAS page shows max ~33 rows; 8 months = ~16 auctions so all fit
    const now = new Date();
    const eightMonthsAgo = new Date(now);
    eightMonthsAgo.setMonth(eightMonthsAgo.getMonth() - 8);

    const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const startYear = eightMonthsAgo.getFullYear().toString();
    const startMonth = MONTHS[eightMonthsAgo.getMonth()];
    const endYear = now.getFullYear().toString();
    const endMonth = MONTHS[now.getMonth()];

    console.log('Scraping', startMonth, startYear, 'to', endMonth, endYear);

    const result = await browserlessRequest(`
      export default async function ({ page }) {
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

        // Set date range — last 12 months
        await page.select('#ContentPlaceHolder1_StartYearDropDownList', '${startYear}');
        await page.select('#ContentPlaceHolder1_EndYearDropDownList', '${endYear}');
        await page.select('#ContentPlaceHolder1_StartMonthDropDownList', '${startMonth}');
        await page.select('#ContentPlaceHolder1_EndMonthDropDownList', '${endMonth}');

        // Select Maturity Date radio to get results sorted with most recent last
        // Then we reverse the parsed results to get most recent first
        const issueDateRadio = await page.$('#ContentPlaceHolder1_IssueDateRadioButton');
        if (issueDateRadio) await issueDateRadio.click();
        try { await page.select('#ContentPlaceHolder1_TermToMaturityAtAuctionTBillsDropDownList', 'All'); } catch(e) {}

        // Select columns: Term(3), Issue Date(6), Maturity Date(7), Cut-off Yield(11), Cut-off Price(12)
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

        // Click Display
        await page.evaluate(() => {
          document.getElementById('ContentPlaceHolder1_DisplayButton').click();
        });

        // Wait for table to appear
        try {
          await page.waitForFunction(
            () => Array.from(document.querySelectorAll('table')).some(t => t.querySelectorAll('tr').length > 3),
            { timeout: 15000 }
          );
        } catch(e) { console.log('waitForFunction timed out'); }

        // Extract table
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

        // Check for pagination links
        const pagination = await page.evaluate(() => {
          const links = Array.from(document.querySelectorAll('a, input[type="submit"]'));
          return links
            .filter(l => {
              const t = (l.innerText || l.value || '').trim().toLowerCase();
              return t === 'next' || t === '>' || t === 'next page' || t === '2' || t.includes('next');
            })
            .map(l => ({ text: l.innerText || l.value, id: l.id, href: l.href }));
        });

        return { tableData, pagination };
      }
    `);

    const rows = result?.tableData || [];
    const pagination = result?.pagination || [];
    console.log('Got', rows.length, 'rows, pagination:', JSON.stringify(pagination));

    // Parse rows
    const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const auctions = [];
    let headerFound = false;
    let colMap = {};

    for (const row of rows) {
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

    console.log('Parsed', auctions.length, 'auctions');

    if (auctions.length === 0) {
      return Response.json({
        success: false,
        message: 'Could not parse auction data.',
        rowCount: rows.length,
        sampleRows: rows.slice(0, 10),
        pagination,
      });
    }

    const saved = await saveAuctions(supabase, auctions);

    return Response.json({
      success: true,
      scraped: auctions.length,
      saved,
      range: startMonth + ' ' + startYear + ' to ' + endMonth + ' ' + endYear,
      pagination,
      sample: auctions.slice(0, 3),
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}