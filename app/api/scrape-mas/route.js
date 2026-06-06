// app/api/scrape-mas/route.js
// Scrapes T-bill auction data from ilovessb.com
// Source has accurate upcoming dates + cut-off yields from MAS
// Cron: every Thursday at 6pm SGT (10:00 UTC) + every Monday to catch new upcoming dates

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

function calcCutoffPrice(yieldPct, tenorDays) {
  const y = parseFloat(yieldPct) / 100;
  const t = parseInt(tenorDays);
  if (isNaN(y) || isNaN(t) || y <= 0) return null;
  return (100 - 100 * y * t / 365).toFixed(3);
}

// Convert "04 Jun 2026" format dates from ilovessb
function normaliseDate(dateStr) {
  if (!dateStr) return null;
  const s = dateStr.trim();
  // Already in "DD Mon YYYY" format
  if (/^\d{1,2}\s+\w{3}\s+\d{4}$/.test(s)) {
    const parts = s.split(/\s+/);
    return parts[0].padStart(2, '0') + ' ' + parts[1] + ' ' + parts[2];
  }
  return s;
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
          cutoff_yield: auction.cutoff_yield || null,
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

async function saveUpcoming(supabase, upcoming) {
  // Store upcoming auctions in a separate table
  let saved = 0;
  for (const item of upcoming) {
    const { error } = await supabase
      .from('tbill_upcoming')
      .upsert(
        {
          auction_date: item.auction_date,
          issue_date: item.issue_date,
          maturity_date: item.maturity_date,
          tenor: item.tenor,
          code: item.code,
          status: item.status,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'auction_date,tenor' }
      );
    if (!error) saved++;
    else console.error('Upcoming upsert error:', error.message);
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
        BROWSERLESS_API_KEY: process.env.BROWSERLESS_API_KEY ? 'set' : 'MISSING',
        SUPABASE_URL: process.env.SUPABASE_URL ? 'set' : 'MISSING',
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'MISSING',
      }
    });
  }

  try {
    const supabase = getSupabaseClient();

    // Use Browserless /scrape to extract table rows directly via CSS selectors
    const apiKey = process.env.BROWSERLESS_API_KEY;
    if (!apiKey) throw new Error('Missing BROWSERLESS_API_KEY');

    const scrapeRes = await fetch(
      'https://production-sfo.browserless.io/scrape?token=' + apiKey,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: 'https://www.ilovessb.com/sgs',
          elements: [{ selector: 'table tr' }],
          gotoOptions: { waitUntil: 'networkidle2' },
        }),
      }
    );

    if (!scrapeRes.ok) throw new Error('Browserless scrape error: ' + scrapeRes.status);

    const scrapeData = await scrapeRes.json();
    const rows = scrapeData?.data?.[0]?.results || [];

    // Build a pseudo-HTML string from scraped rows for our parser
    const html = rows.map(r => '<tr>' + r.html + '</tr>').join('\n');

    // Parse scraped rows — detect tenor by looking for section headers nearby
    function parseRows(rowsHtml, allRowHtmls) {
      const results = [];
      let currentTenor = '6-month';

      for (const rowHtml of allRowHtmls) {
        const text = rowHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

        // Detect section headers
        if (/6-Month T-bill/i.test(text)) { currentTenor = '6-month'; continue; }
        if (/1-Year T-bill/i.test(text)) { currentTenor = '1-year'; continue; }
        if (/2-Year SGS|5-Year SGS|10-Year/i.test(text)) break; // stop at bond sections

        // Extract cells
        const cells = [];
        const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
        let m;
        while ((m = tdRegex.exec(rowHtml)) !== null) {
          cells.push(m[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim());
        }

        if (cells.length < 6) continue;
        if (!/^\d{1,2}\s+\w{3}\s+\d{4}$/.test(cells[1])) continue; // auction date in col 1

        const yieldVal = cells[6] || '';
        const price = cells[7] || '';
        const tenorDays = currentTenor === '1-year' ? 364 : 182;

        results.push({
          auction_date: normaliseDate(cells[1]),
          issue_date: normaliseDate(cells[2]),
          maturity_date: normaliseDate(cells[3]),
          tenor: currentTenor,
          code: (cells[4] || '').trim(),
          status: (cells[5] || '').trim().toLowerCase(),
          cutoff_yield: yieldVal ? yieldVal + '%' : null,
          cutoff_price: price || (yieldVal ? calcCutoffPrice(yieldVal, tenorDays) : null),
        });
      }
      return results;
    }

    const allRowHtmls = rows.map(r => r.html || '');
    const allData = parseRows(html, allRowHtmls);

    console.log('Parsed', allData.length, 'entries from ilovessb');

    if (allData.length === 0) {
      // Check if tables exist in the HTML at all
      return Response.json({
        success: false,
        message: 'Could not parse ilovessb data',
        rowCount: rows.length,
        sampleRow: rows[0]?.html?.slice(0, 200) || 'no rows',
      });
    }

    // Split into closed (have yield) and upcoming (no yield)
    const closed = allData.filter(a => a.cutoff_yield && a.status === 'closed');
    const upcoming = allData.filter(a => a.status !== 'closed');

    console.log('Closed:', closed.length, 'Upcoming:', upcoming.length);

    // Save closed auctions to tbill_auctions
    const savedAuctions = closed.length > 0 ? await saveAuctions(supabase, closed) : 0;

    // Save upcoming to tbill_upcoming
    const savedUpcoming = upcoming.length > 0 ? await saveUpcoming(supabase, upcoming) : 0;

    return Response.json({
      success: true,
      source: 'ilovessb.com',
      closedAuctions: { found: closed.length, saved: savedAuctions },
      upcomingAuctions: { found: upcoming.length, saved: savedUpcoming },
      sample: {
        closed: closed.slice(0, 3),
        upcoming: upcoming.slice(0, 3),
      },
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}