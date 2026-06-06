// app/api/scrape-mas/route.js
// Fetches T-bill data from ilovessb.com individual T-bill pages
// These pages are server-rendered and fetchable without Browserless
// Strategy: fetch nav first to get latest codes, then fetch each T-bill page
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

// Parse upcoming auctions table from ilovessb T-bill page
// Table format: | Announcement | Auction | Issue | Maturity | Code | ISIN |
function parseUpcomingTable(markdown, tenor) {
  const results = [];
  const lines = markdown.split('\n');
  let inUpcoming = false;

  for (const line of lines) {
    if (/## Upcoming Auctions/i.test(line)) { inUpcoming = true; continue; }
    if (inUpcoming && /^##\s/.test(line)) break; // next section

    if (!inUpcoming || !line.includes('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 4) continue;
    if (!/^\d{1,2}\s+\w{3}\s+\d{4}$/.test(cells[0])) continue; // skip header/separator

    results.push({
      auction_date: normaliseDate(cells[1]),
      issue_date: normaliseDate(cells[2]),
      maturity_date: normaliseDate(cells[3]),
      tenor,
      code: cells[4] || '',
      status: 'upcoming',
      updated_at: new Date().toISOString(),
    });
  }
  return results;
}

// Parse cut-off yield and auction details from a closed T-bill page
function parseClosedAuction(markdown, tenor) {
  // Extract auction date from title e.g. "# 6-Month T-bill BS26110S (21 May 2026)"
  const titleMatch = markdown.match(/# (?:6-Month|1-Year) T-bill \w+ \((\d{1,2} \w{3} \d{4})\)/);
  const auctionDate = titleMatch ? normaliseDate(titleMatch[1]) : null;

  // Extract maturity date
  const maturityMatch = markdown.match(/Maturity Date\s*\n(\d{1,2} \w{3} \d{4})/);
  const maturityDate = maturityMatch ? normaliseDate(maturityMatch[1]) : null;

  // Extract cut-off yield from statistics table
  // "| Auction Date | Issue Code | Cut-Off Yield (%) |" followed by data rows
  const yieldMatch = markdown.match(/Cut-Off Yield \(%\)[^\n]*\n[^\n]*\n\|\s*[\d ]+\w{3} \d{4}\s*\|\s*\w+\s*\|\s*([\d.]+)/);
  const cutoffYield = yieldMatch ? yieldMatch[1] : null;

  if (!auctionDate || !cutoffYield) return null;

  const tenorDays = tenor === '1-year' ? 364 : 182;
  return {
    auction_date: auctionDate,
    tenor,
    cutoff_yield: parseFloat(cutoffYield).toFixed(2) + '%',
    cutoff_price: calcCutoffPrice(cutoffYield, tenorDays),
    maturity_date: maturityDate,
    scraped_at: new Date().toISOString(),
  };
}

async function upsertRecords(supabase, table, records, conflictCol) {
  let saved = 0;
  for (const record of records) {
    const { error } = await supabase.from(table).upsert(record, { onConflict: conflictCol });
    if (!error) saved++;
    else console.error('Upsert error on', table, ':', error.message);
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

    // Step 1 — Use known current T-bill page URLs
    // Update these when a new auction opens (every ~2 weeks for 6-month, quarterly for 1-year)
    // URL format: /[tenor]-tbill/[CODE]-[DD]-[Mon]-[YYYY]
    const baseUrl = 'https://www.ilovessb.com';
    const sixMonthUrl = '/6-month-tbill/BS26111H-04-Jun-2026';
    const oneYearUrl = '/1-year-tbill/BY26101H-16-Apr-2026';
    const results = { upcoming: [], closed: [] };

    // Step 2 — Fetch 6-month T-bill page and convert to plain text
    const sixMonthHtml = await fetchPage(baseUrl + sixMonthUrl);
    const sixMonthMarkdown = sixMonthHtml
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s{2,}/g, ' ')
      .replace(/ \n/g, '\n');
    const sixMonthUpcoming = parseUpcomingTable(sixMonthMarkdown, '6-month');
    results.upcoming.push(...sixMonthUpcoming);

    // Check if this page is for a closed auction — parse yield
    const sixMonthClosed = parseClosedAuction(sixMonthMarkdown, '6-month');
    if (sixMonthClosed) results.closed.push(sixMonthClosed);

    // Step 3 — Fetch 1-year T-bill page
    if (oneYearUrl) {
      const oneYearHtml = await fetchPage(baseUrl + oneYearUrl);
      const oneYearMarkdown = oneYearHtml
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/\s{2,}/g, ' ')
        .replace(/ \n/g, '\n');
      const oneYearUpcoming = parseUpcomingTable(oneYearMarkdown, '1-year');
      results.upcoming.push(...oneYearUpcoming);

      const oneYearClosed = parseClosedAuction(oneYearMarkdown, '1-year');
      if (oneYearClosed) results.closed.push(oneYearClosed);
    }

    // Step 4 — Save to Supabase
    const savedAuctions = results.closed.length > 0
      ? await upsertRecords(supabase, 'tbill_auctions', results.closed, 'auction_date,tenor')
      : 0;

    const savedUpcoming = results.upcoming.length > 0
      ? await upsertRecords(supabase, 'tbill_upcoming', results.upcoming, 'auction_date,tenor')
      : 0;

    return Response.json({
      success: true,
      source: 'ilovessb.com',
      debug: {
        sixMonthTextPreview: sixMonthMarkdown.slice(0, 500),
        hasUpcomingSection: sixMonthMarkdown.includes('Upcoming Auctions'),
        sixMonthUpcomingCount: sixMonthUpcoming.length,
      },
      closed: { found: results.closed.length, saved: savedAuctions, data: results.closed },
      upcoming: { found: results.upcoming.length, saved: savedUpcoming, data: results.upcoming.slice(0, 3) },
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}