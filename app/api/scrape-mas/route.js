// app/api/scrape-mas/route.js
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
    const currentYear = now.getFullYear().toString();
    const currentMonth = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][now.getMonth()];
    const startYear = (now.getFullYear() - 1).toString();

    const result = await browserlessRequest(`
      export default async function ({ page }) {
        // Intercept XHR/fetch to capture UpdatePanel response
        const ajaxResponses = [];
        await page.setRequestInterception(true);
        page.on('request', req => req.continue());
        page.on('response', async res => {
          const url = res.url();
          const ct = res.headers()['content-type'] || '';
          if (url.includes('fdanet') || ct.includes('text/plain') || ct.includes('text/html')) {
            try {
              const text = await res.text();
              if (text.length > 100) ajaxResponses.push({ url, length: text.length, preview: text.slice(0, 200) });
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
        await page.select('#ContentPlaceHolder1_EndYearDropDownList', '${currentYear}');
        await page.select('#ContentPlaceHolder1_StartMonthDropDownList', 'Jan');
        await page.select('#ContentPlaceHolder1_EndMonthDropDownList', '${currentMonth}');
        try { await page.select('#ContentPlaceHolder1_TermToMaturityAtAuctionTBillsDropDownList', 'All'); } catch(e) {}

        // Uncheck all column checkboxes then check needed ones
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
        await page.click('#ContentPlaceHolder1_DisplayButton');

        // Wait for table to appear in DOM — up to 15 seconds
        try {
          await page.waitForFunction(
            () => {
              const tables = document.querySelectorAll('table');
              for (const t of tables) {
                const rows = t.querySelectorAll('tr');
                if (rows.length > 3) return true;
              }
              return false;
            },
            { timeout: 15000 }
          );
        } catch(e) {
          console.log('waitForFunction timed out — extracting anyway');
        }

        // Extract table data
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

        const pageText = await page.evaluate(() => document.body.innerText.slice(800, 3000));

        return { tableData, pageText, ajaxResponses: ajaxResponses.slice(0, 5) };
      }
    `);

    const rows = result?.tableData || [];
    const pageText = result?.pageText || '';
    const ajaxResponses = result?.ajaxResponses || [];
    console.log('Rows:', rows.length, 'AJAX responses:', ajaxResponses.length);

    // Parse rows
    // Data format from MAS: [Term(days), Unit, IssueDate(DD/MM/YYYY), MaturityDate, Yield, Price]
    // Header row has newlines e.g. "Cut-off\nYield (%)"
    const auctions = [];
    let headerFound = false;
    let colMap = {};

    for (const row of rows) {
      const cells = row.cells || [];
      if (cells.length < 2) continue;

      // Normalise cells — remove newlines for header matching
      const normCells = cells.map(c => c.replace(/\n/g, ' ').trim());

      // Detect header row
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
        console.log('colMap:', JSON.stringify(colMap));
        continue;
      }

      if (!headerFound) continue;

      // Skip rows that are clearly not data
      if (normCells[0] === 'Bond Auction Results') continue;

      // Extract fields using column map
      // From sample: ["182","Day","07/01/2025","08/07/2025","3.05","98.479"]
      // colMap based on header: term=0, issueDate=2, maturityDate=3, yield=4, price=5
      const issueDate = colMap.issueDate !== undefined ? normCells[colMap.issueDate] : normCells.find(c => /\d{2}\/\d{2}\/\d{4}/.test(c));
      const maturityDate = colMap.maturityDate !== undefined ? normCells[colMap.maturityDate] : null;
      const yieldVal = colMap.yield !== undefined ? normCells[colMap.yield] : normCells.find(c => /^\d+\.\d{2,4}$/.test(c) && parseFloat(c) < 15 && parseFloat(c) > 0);
      const price = colMap.price !== undefined ? normCells[colMap.price] : normCells.find(c => /^9[5-9]\.\d+$/.test(c));
      const termDays = colMap.term !== undefined ? normCells[colMap.term] : normCells[0];

      if (!issueDate || !yieldVal) continue;
      if (!/\d{2}\/\d{2}\/\d{4}/.test(issueDate)) continue;

      // Convert DD/MM/YYYY to readable format
      const [day, month, year] = issueDate.split('/');
      const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const formattedDate = day + ' ' + months[parseInt(month) - 1] + ' ' + year;

      let formattedMaturity = null;
      if (maturityDate && /\d{2}\/\d{2}\/\d{4}/.test(maturityDate)) {
        const [md, mm, my] = maturityDate.split('/');
        formattedMaturity = md + ' ' + months[parseInt(mm) - 1] + ' ' + my;
      }

      // Determine tenor from term days
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
        rowCount: rows.length,
        sampleRows: rows.slice(0, 20),
        pageTextPreview: pageText,
        colMap,
        ajaxResponses,
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