// app/api/scrape-mas/route.js
// Scrapes T-bill data from ilovessb.com individual T-bill pages
// Cron: every Thursday 6pm SGT (10:00 UTC) + every Monday 10am SGT (02:00 UTC)

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

function normaliseDate(raw) {
  if (!raw) return null;
  const parts = raw.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  return parts[0].padStart(2, '0') + ' ' + parts[1] + ' ' + parts[2];
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
}

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-SG,en;q=0.9',
};

async function fetchPage(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error('Fetch failed: ' + url + ' status ' + res.status);
  return res.text();
}

// Parse HTML tables from a page — returns array of row arrays
function parseHtmlTables(html) {
  const tables = [];
  const tableRegex = /<table[\s\S]*?<\/table>/gi;
  let tableMatch;
  while ((tableMatch = tableRegex.exec(html)) !== null) {
    const rows = [];
    const trRegex = /<tr[\s\S]*?<\/tr>/gi;
    let trMatch;
    while ((trMatch = trRegex.exec(tableMatch[0])) !== null) {
      const cells = [];
      const tdRegex = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let tdMatch;
      while ((tdMatch = tdRegex.exec(trMatch[0])) !== null) {
        cells.push(stripTags(tdMatch[1]).replace(/\s+/g, ' ').trim());
      }
      if (cells.length > 0) rows.push(cells);
    }
    if (rows.length > 0) tables.push(rows);
  }
  return tables;
}

// Extract cut-off yield from page text
function extractCutoffYield(html) {
  const text = stripTags(html).replace(/\s+/g, ' ');
  const match = text.match(/Cut-Off Yield\s+([\d.]+)%/) ||
                text.match(/cut.off yield.*?([\d.]+)%/i);
  return match ? parseFloat(match[1]) : null;
}

// Extract auction date from page title
function extractAuctionDate(html) {
  const match = html.match(/(\d{1,2}\s+\w{3}\s+\d{4})\)\s*(?:Cut-Off|Closed|Upcoming|Closing)/i) ||
                html.match(/<title>[^(]+\((\d{1,2}\s+\w{3}\s+\d{4})\)/i);
  return match ? normaliseDate(match[1]) : null;
}

// Extract maturity date from auction details section
function extractMaturityDate(html) {
  const match = html.match(/Maturity Date[\s\S]{0,50}?(\d{1,2}\s+\w{3}\s+\d{4})/i);
  return match ? normaliseDate(match[1]) : null;
}

async function upsertRecords(supabase, table, records, conflictCol) {
  let saved = 0;
  for (const record of records) {
    const { error } = await supabase.from(table).upsert(record, { onConflict: conflictCol });
    if (!error) saved++;
    else console.error('Upsert error:', error.message);
  }
  return saved;
}

export async function GET(request) {
  if (!isAuthorised(request)) {
    return Response.json({ error: 'Unauthorised' }, { status: 401 });
  }

  if (new URL(request.url).searchParams.get('debug') === '1') {
    return Response.json({
      env: {
        SUPABASE_URL: process.env.SUPABASE_URL ? 'set' : 'MISSING',
        SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY ? 'set' : 'MISSING',
        CRON_SECRET: process.env.CRON_SECRET ? 'set' : 'MISSING',
      }
    });
  }

  try {
    const supabase = getSupabaseClient();

    const baseUrl = 'https://www.ilovessb.com';

    // Known current T-bill page URLs — update these when a new auction opens
    // 6-month: every ~2 weeks | 1-year: quarterly
    const TBILL_PAGES = [
      { url: baseUrl + '/6-month-tbill/BS26111H-04-Jun-2026', tenor: '6-month' },
      { url: baseUrl + '/1-year-tbill/BY26101H-16-Apr-2026', tenor: '1-year' },
    ];

    const closed = [];
    const upcoming = [];

    for (const { url, tenor } of TBILL_PAGES) {
      const html = await fetchPage(url);
      const tenorDays = tenor === '1-year' ? 364 : 182;

      // Extract closed auction data
      const auctionDate = extractAuctionDate(html);
      const cutoffYield = extractCutoffYield(html);
      const maturityDate = extractMaturityDate(html);

      if (auctionDate && cutoffYield) {
        closed.push({
          auction_date: auctionDate,
          tenor,
          cutoff_yield: cutoffYield.toFixed(2) + '%',
          cutoff_price: calcCutoffPrice(cutoffYield, tenorDays),
          maturity_date: maturityDate,
          scraped_at: new Date().toISOString(),
        });
      }

      // Extract upcoming auctions from tables
      const tables = parseHtmlTables(html);
      const dateRe = /^\d{1,2}\s+\w{3}\s+\d{4}$/;

      for (const table of tables) {
        for (const row of table) {
          // Upcoming table columns: Announcement | Auction | Issue | Maturity | Code | ISIN
          if (row.length < 4) continue;
          if (!dateRe.test(row[0]) || !dateRe.test(row[1])) continue;

          // Skip if this looks like a yield statistics table
          if (/^\d+\.\d+$/.test(row[2])) continue;

          upcoming.push({
            auction_date: normaliseDate(row[1]),
            issue_date: normaliseDate(row[2]),
            maturity_date: normaliseDate(row[3]),
            tenor,
            code: row[4] || '',
            status: 'upcoming',
            updated_at: new Date().toISOString(),
          });
        }
      }
    }

    const savedAuctions = closed.length > 0
      ? await upsertRecords(supabase, 'tbill_auctions', closed, 'auction_date,tenor')
      : 0;

    const savedUpcoming = upcoming.length > 0
      ? await upsertRecords(supabase, 'tbill_upcoming', upcoming, 'auction_date,tenor')
      : 0;

    return Response.json({
      success: true,
      source: 'ilovessb.com',
      closed: { found: closed.length, saved: savedAuctions, data: closed },
      upcoming: { found: upcoming.length, saved: savedUpcoming, sample: upcoming.slice(0, 3) },
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}