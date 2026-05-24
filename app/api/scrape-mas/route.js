// app/api/scrape-mas/route.js
// Scrapes MAS T-Bill auction results using Browserless
// MAS page requires form interaction to load results

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

        // Wait for dropdowns to be ready
        await page.waitForSelector('#ContentPlaceHolder1_StartYearDropDownList', { timeout: 10000 });

        // Select T-bills product type radio/checkbox
        // Try clicking the T-bills option
        const tbillsClicked = await page.evaluate(() => {
          // Look for radio buttons or checkboxes for T-bills
          const inputs = Array.from(document.querySelectorAll('input[type="radio"], input[type="checkbox"]'));
          const tbillInput = inputs.find(i => {
            const label = document.querySelector('label[for="' + i.id + '"]');
            return (label && label.innerText.includes('T-bills')) || i.value.includes('T-bill') || i.id.includes('Tbill') || i.id.includes('TBill');
          });
          if (tbillInput) { tbillInput.click(); return true; }
          return false;
        });

        console.log('T-bills radio clicked:', tbillsClicked);

        // Set start year to ${startYear}
        await page.select('#ContentPlaceHolder1_StartYearDropDownList', '${startYear}');

        // Set end year to ${currentYear}
        await page.select('#ContentPlaceHolder1_EndYearDropDownList', '${currentYear}');

        // Set start month to Jan
        await page.select('#ContentPlaceHolder1_StartMonthDropDownList', 'Jan');

        // Set end month to Dec
        await page.select('#ContentPlaceHolder1_EndMonthDropDownList', 'Dec');

        // Set T-bills term to "All"
        await page.select('#ContentPlaceHolder1_TermToMaturityAtAuctionTBillsDropDownList', 'All');

        // Find and click the search/show button
        const buttonClicked = await page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('input[type="submit"], button[type="submit"], input[type="button"], button'));
          const searchBtn = buttons.find(b => {
            const text = (b.value || b.innerText || '').toLowerCase();
            return text.includes('show') || text.includes('search') || text.includes('go') || text.includes('submit');
          });
          if (searchBtn) { searchBtn.click(); return searchBtn.value || searchBtn.innerText; }
          return null;
        });

        console.log('Search button clicked:', buttonClicked);

        // Wait for results to load
        await new Promise(r => setTimeout(r, 4000));

        // Extract table data
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

        // Also get page text for debugging
        const pageText = await page.evaluate(() => document.body.innerText.slice(0, 2000));

        return { tableData, pageText, tbillsClicked, buttonClicked };
      }
    `);

    const rows = result?.tableData || [];
    const pageText = result?.pageText || '';
    console.log('Got', rows.length, 'rows, tbillsClicked:', result?.tbillsClicked, 'buttonClicked:', result?.buttonClicked);

    // Parse rows into auction records
    const auctions = [];
    for (const row of rows) {
      const cells = row.cells || [];
      if (cells.length < 3) continue;

      // Skip header rows
      const allText = cells.join(' ').toLowerCase();
      if (allText.includes('issue date') || allText.includes('maturity date') || allText.includes('auction date')) continue;

      // Look for date pattern
      const dateMatch = cells.find(c =>
        /\d{1,2}\s+\w{3}\s+\d{4}/.test(c) ||
        /\d{2}\/\d{2}\/\d{4}/.test(c) ||
        /\d{4}-\d{2}-\d{2}/.test(c)
      );

      // Look for yield (small decimal number between 0 and 15)
      const yieldMatch = cells.find(c => /^\d+\.\d{2,4}$/.test(c) && parseFloat(c) < 15 && parseFloat(c) > 0);

      // Look for price (high 90s number)
      const priceMatch = cells.find(c => /^9[5-9]\.\d+$/.test(c));

      // Look for maturity date (second date in row)
      const dates = cells.filter(c => /\d{1,2}\s+\w{3}\s+\d{4}|\d{2}\/\d{2}\/\d{4}/.test(c));
      const maturityDate = dates.length > 1 ? dates[1] : null;

      if (!dateMatch || !yieldMatch) continue;

      // Determine tenor
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
        message: 'Page loaded but no auction data found. Check sample rows.',
        rowCount: rows.length,
        sampleRows: rows.slice(0, 10),
        pageTextPreview: pageText.slice(0, 500),
        tbillsClicked: result?.tbillsClicked,
        buttonClicked: result?.buttonClicked,
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