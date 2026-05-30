// app/api/scrape-mas/route.js
// Scrapes MAS T-Bill auction results using Browserless
// Form interaction: select T-bills checkbox, set date range, click Display button

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

  // Inspect checkboxes on the page
  if (params.get('inspect') === '1') {
    try {
      const result = await browserlessRequest(`
        export default async function ({ page }) {
          await page.goto('https://eservices.mas.gov.sg/statistics/fdanet/BondTreasuryBillsCMTBsAuctions.aspx', {
            waitUntil: 'networkidle2',
            timeout: 30000,
          });
          await page.waitForSelector('#ContentPlaceHolder1_StartYearDropDownList', { timeout: 10000 });

          const checkboxes = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('input[type="checkbox"]')).map(c => {
              const label = document.querySelector('label[for="' + c.id + '"]');
              return { id: c.id, name: c.name, value: c.value, label: label ? label.innerText.trim() : '', checked: c.checked };
            });
          });

          const allInputs = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('#ContentPlaceHolder1 input')).map(i => ({
              type: i.type, id: i.id, name: i.name, value: i.value,
              label: (() => { const l = document.querySelector('label[for="' + i.id + '"]'); return l ? l.innerText.trim() : ''; })()
            }));
          });

          return { checkboxes, allInputs };
        }
      `);
      return Response.json({ inspect: result });
    } catch (err) {
      return Response.json({ error: err.message });
    }
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

        // Find and check the T-bills checkbox
        const tbillChecked = await page.evaluate(() => {
          const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
          const tbill = checkboxes.find(c => {
            const label = document.querySelector('label[for="' + c.id + '"]');
            const labelText = label ? label.innerText.trim() : '';
            return labelText === 'T-bills' || c.value.toLowerCase().includes('tbill') ||
                   c.id.toLowerCase().includes('tbill') || labelText.toLowerCase().includes('t-bill');
          });
          if (tbill) {
            // Uncheck all other product checkboxes first
            const allCheckboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
            allCheckboxes.forEach(c => { if (c !== tbill) c.checked = false; });
            tbill.checked = true;
            tbill.dispatchEvent(new Event('change', { bubbles: true }));
            tbill.dispatchEvent(new Event('click', { bubbles: true }));
            const label = document.querySelector('label[for="' + tbill.id + '"]');
            return { found: true, id: tbill.id, label: label ? label.innerText.trim() : '' };
          }
          return { found: false };
        });

        console.log('T-bill checkbox:', JSON.stringify(tbillChecked));

        // Set date range
        await page.select('#ContentPlaceHolder1_StartYearDropDownList', '${startYear}');
        await page.select('#ContentPlaceHolder1_EndYearDropDownList', '${currentYear}');
        await page.select('#ContentPlaceHolder1_StartMonthDropDownList', 'Jan');
        await page.select('#ContentPlaceHolder1_EndMonthDropDownList', 'Dec');

        // Set tenor to All
        try {
          await page.select('#ContentPlaceHolder1_TermToMaturityAtAuctionTBillsDropDownList', 'All');
        } catch(e) {}

        await new Promise(r => setTimeout(r, 500));

        // Click the Display button — we know its exact ID
        await page.click('#ContentPlaceHolder1_DisplayButton');
        console.log('Clicked Display button');

        // Wait for results
        await new Promise(r => setTimeout(r, 5000));

        // Extract all table data
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

        const pageText = await page.evaluate(() => document.body.innerText.slice(1000, 3000));

        return { tableData, pageText, tbillChecked };
      }
    `);

    const rows = result?.tableData || [];
    const pageText = result?.pageText || '';
    console.log('Got', rows.length, 'rows, tbillChecked:', JSON.stringify(result?.tbillChecked));

    // Parse rows into auction records
    const auctions = [];
    for (const row of rows) {
      const cells = row.cells || [];
      if (cells.length < 3) continue;

      const allText = cells.join(' ');

      // Skip pure header rows with no dates
      if (/^(issue date|maturity date|cut.off|tenor|product|isin)$/i.test(cells[0])) continue;

      const dateMatch = cells.find(c =>
        /\d{1,2}\s+\w{3}\s+\d{4}/.test(c) ||
        /\d{2}\/\d{2}\/\d{4}/.test(c) ||
        /\d{4}-\d{2}-\d{2}/.test(c)
      );

      const yieldMatch = cells.find(c =>
        /^\d+\.\d{2,4}$/.test(c) && parseFloat(c) < 15 && parseFloat(c) > 0
      );

      const priceMatch = cells.find(c => /^9[5-9]\.\d+$/.test(c));

      const dates = cells.filter(c =>
        /\d{1,2}\s+\w{3}\s+\d{4}|\d{2}\/\d{2}\/\d{4}/.test(c)
      );
      const maturityDate = dates.length > 1 ? dates[1] : null;

      if (!dateMatch || !yieldMatch) continue;

      const tenor = /1.year|1-year|364|12.month|1 year/i.test(allText) ? '1-year' : '6-month';

      auctions.push({
        auction_date: dateMatch.trim(),
        tenor,
        cutoff_yield: parseFloat(yieldMatch).toFixed(2) + '%',
        cutoff_price: priceMatch || null,
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
        tbillChecked: result?.tbillChecked,
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