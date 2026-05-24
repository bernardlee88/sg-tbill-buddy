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

  // Inspect mode — see all buttons and inputs on page after form interaction
  if (params.get('inspect') === '1') {
    try {
      const result = await browserlessRequest(`
        export default async function ({ page }) {
          await page.goto('https://eservices.mas.gov.sg/statistics/fdanet/BondTreasuryBillsCMTBsAuctions.aspx', {
            waitUntil: 'networkidle2',
            timeout: 30000,
          });
          await page.waitForSelector('#ContentPlaceHolder1_StartYearDropDownList', { timeout: 10000 });

          // Get all buttons and submit inputs inside the main content area
          const buttons = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button')).map(b => ({
              tag: b.tagName,
              type: b.type,
              id: b.id,
              name: b.name,
              value: b.value,
              text: b.innerText,
              className: b.className,
            }));
          });

          // Get all radio buttons and their labels
          const radios = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('input[type="radio"]')).map(r => {
              const label = document.querySelector('label[for="' + r.id + '"]');
              return { id: r.id, name: r.name, value: r.value, label: label ? label.innerText : '', checked: r.checked };
            });
          });

          return { buttons, radios };
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

        // Click T-bills radio button
        await page.evaluate(() => {
          const radios = Array.from(document.querySelectorAll('input[type="radio"]'));
          const tbill = radios.find(r => {
            const label = document.querySelector('label[for="' + r.id + '"]');
            const labelText = label ? label.innerText.trim() : '';
            return labelText === 'T-bills' || r.value === 'T-bills' || r.value === 'TBills';
          });
          if (tbill) tbill.click();
        });

        await new Promise(r => setTimeout(r, 500));

        // Set date range
        await page.select('#ContentPlaceHolder1_StartYearDropDownList', '${startYear}');
        await page.select('#ContentPlaceHolder1_EndYearDropDownList', '${currentYear}');
        await page.select('#ContentPlaceHolder1_StartMonthDropDownList', 'Jan');
        await page.select('#ContentPlaceHolder1_EndMonthDropDownList', 'Dec');

        // Set T-bills tenor to All
        try {
          await page.select('#ContentPlaceHolder1_TermToMaturityAtAuctionTBillsDropDownList', 'All');
        } catch(e) {}

        // Click the Show Results button — look for input[type=submit] inside the form
        // NOT the navigation buttons
        const submitClicked = await page.evaluate(() => {
          // Find submit button inside ContentPlaceHolder (main content area)
          const mainContent = document.querySelector('#ContentPlaceHolder1') ||
                              document.querySelector('[id*="ContentPlaceHolder"]') ||
                              document.querySelector('form');

          if (mainContent) {
            const submitBtn = mainContent.querySelector('input[type="submit"], input[type="button"][value*="Show"], input[type="button"][id*="Show"], input[type="button"][id*="search"]');
            if (submitBtn) {
              submitBtn.click();
              return { clicked: true, id: submitBtn.id, value: submitBtn.value };
            }

            // Try any input[type=submit] inside form
            const allSubmits = Array.from(mainContent.querySelectorAll('input[type="submit"], input[type="button"]'));
            if (allSubmits.length > 0) {
              allSubmits[0].click();
              return { clicked: true, id: allSubmits[0].id, value: allSubmits[0].value };
            }
          }

          // Last resort — find by ID pattern
          const showBtn = document.querySelector('[id*="Show"], [id*="Submit"], [id*="Search"], [id*="Go"]');
          if (showBtn) {
            showBtn.click();
            return { clicked: true, id: showBtn.id, value: showBtn.value || showBtn.innerText };
          }

          return { clicked: false };
        });

        // Wait for results to load
        await new Promise(r => setTimeout(r, 5000));

        // Extract table data
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

        const pageText = await page.evaluate(() => document.body.innerText.slice(0, 3000));

        return { tableData, pageText, submitClicked };
      }
    `);

    const rows = result?.tableData || [];
    const pageText = result?.pageText || '';
    console.log('Got', rows.length, 'rows, submitClicked:', JSON.stringify(result?.submitClicked));

    // Parse rows into auction records
    const auctions = [];
    for (const row of rows) {
      const cells = row.cells || [];
      if (cells.length < 3) continue;

      const allText = cells.join(' ');

      // Skip header rows
      if (/issue date|maturity date|cut.off|tenor/i.test(allText) && !/\d{4}/.test(cells[0])) continue;

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
        sampleRows: rows.slice(0, 10),
        pageTextPreview: pageText.slice(500, 2000),
        submitClicked: result?.submitClicked,
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