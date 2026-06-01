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

    // Fetch ilovessb.com/sgs — no Browserless needed, plain fetch works
    const res = await fetch('https://www.ilovessb.com/sgs', {
      headers: { 'User-Agent': 'SGTBillBuddy/1.0' },
    });

    if (!res.ok) throw new Error('ilovessb fetch error: ' + res.status);

    const html = await res.text();

    // Parse 6-month T-bill table
    const sixMonthAuctions = [];
    const oneYearAuctions = [];

    // Extract table rows using regex on the markdown-like HTML
    // Row format: | date | date | date | date | code | status | yield | price |
    const rowPattern = /\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*\|\s*(\w+)\s*\|\s*(\w+)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/g;

    // Find 6-month section
    const sixMonthSection = html.match(/6-Month T-bill[\s\S]*?(?=1-Year T-bill|##)/i)?.[0] || '';
    const oneYearSection = html.match(/1-Year T-bill[\s\S]*?(?=2-Year|##)/i)?.[0] || '';

    function parseSection(sectionHtml, tenor) {
      const results = [];
      let match;
      const re = /\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*\|\s*(\d{1,2}\s+\w{3}\s+\d{4})\s*\|\s*([A-Z0-9]+)\s*\|\s*(\w+)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|/g;
      while ((match = re.exec(sectionHtml)) !== null) {
        const [, announcement, auction, issue, maturity, code, status, yieldVal, price] = match;
        const auctionDate = normaliseDate(auction);
        const maturityDate = normaliseDate(maturity);
        const issueDate = normaliseDate(issue);
        const tenorDays = tenor === '1-year' ? 364 : 182;

        const entry = {
          auction_date: auctionDate,
          issue_date: issueDate,
          maturity_date: maturityDate,
          tenor,
          code: code.trim(),
          status: status.trim().toLowerCase(),
          cutoff_yield: yieldVal ? yieldVal + '%' : null,
          cutoff_price: price || (yieldVal ? calcCutoffPrice(yieldVal, tenorDays) : null),
        };

        results.push(entry);
      }
      return results;
    }

    const sixMonthData = parseSection(sixMonthSection, '6-month');
    const oneYearData = parseSection(oneYearSection, '1-year');
    const allData = [...sixMonthData, ...oneYearData];

    console.log('Parsed', allData.length, 'entries from ilovessb');

    if (allData.length === 0) {
      return Response.json({
        success: false,
        message: 'Could not parse ilovessb data',
        htmlPreview: html.slice(0, 500),
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