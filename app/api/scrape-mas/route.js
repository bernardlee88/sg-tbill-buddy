// app/api/scrape-mas/route.js
// Scrapes T-bill auction data from ilovessb.com
// Page returns server-rendered markdown tables — no JS rendering needed
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

function normaliseDate(dateStr) {
  if (!dateStr) return null;
  const parts = dateStr.trim().split(/\s+/);
  if (parts.length !== 3) return null;
  return parts[0].padStart(2, '0') + ' ' + parts[1] + ' ' + parts[2];
}

// Parse a markdown table section for T-bills
// Row format: | Announcement | Auction | Issue | Maturity | Code | Status | Yield | Price |
function parseMarkdownTable(text, tenor) {
  const results = [];
  const tenorDays = tenor === '1-year' ? 364 : 182;
  const lines = text.split('\n');

  for (const line of lines) {
    if (!line.includes('|')) continue;
    const cells = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cells.length < 6) continue;

    // Must have a valid date in column 1 (auction date)
    if (!/^\d{1,2}\s+\w{3}\s+\d{4}$/.test(cells[1])) continue;

    const yieldVal = cells[6] || '';
    const price = cells[7] || '';
    const status = (cells[5] || '').toLowerCase();

    results.push({
      auction_date: normaliseDate(cells[1]),
      issue_date: normaliseDate(cells[2]),
      maturity_date: normaliseDate(cells[3]),
      tenor,
      code: (cells[4] || '').trim(),
      status,
      cutoff_yield: yieldVal ? parseFloat(yieldVal).toFixed(2) + '%' : null,
      cutoff_price: price || (yieldVal ? calcCutoffPrice(yieldVal, tenorDays) : null),
    });
  }
  return results;
}

async function saveToSupabase(supabase, table, records, conflictCol) {
  let saved = 0;
  for (const record of records) {
    const { error } = await supabase
      .from(table)
      .upsert(record, { onConflict: conflictCol });
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

    // Fetch ilovessb.com with a browser-like User-Agent to avoid bot blocks
    const res = await fetch('https://www.ilovessb.com/sgs', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-SG,en;q=0.9',
      },
    });

    if (!res.ok) throw new Error('Fetch error: ' + res.status);
    const html = await res.text();

    // Convert HTML to plain text for markdown parsing
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\r/g, '');

    // Extract 6-month and 1-year sections
    const sixMonthStart = text.indexOf('6-Month T-bill');
    const oneYearStart = text.indexOf('1-Year T-bill');
    const twoYearStart = text.indexOf('2-Year SGS');

    if (sixMonthStart === -1) {
      return Response.json({
        success: false,
        message: 'Could not find 6-Month T-bill section',
        textPreview: text.slice(0, 300),
      });
    }

    const sixMonthText = text.slice(sixMonthStart, oneYearStart > sixMonthStart ? oneYearStart : sixMonthStart + 2000);
    const oneYearText = oneYearStart > 0 ? text.slice(oneYearStart, twoYearStart > oneYearStart ? twoYearStart : oneYearStart + 1000) : '';

    const sixMonthData = parseMarkdownTable(sixMonthText, '6-month');
    const oneYearData = parseMarkdownTable(oneYearText, '1-year');
    const allData = [...sixMonthData, ...oneYearData];

    if (allData.length === 0) {
      return Response.json({
        success: false,
        message: 'Could not parse any rows',
        sixMonthPreview: sixMonthText.slice(0, 300),
      });
    }

    // Split into closed (with yield) and upcoming
    const closed = allData.filter(a => a.cutoff_yield && a.status === 'closed');
    const upcoming = allData.filter(a => a.status === 'upcoming');

    // Save closed auctions to tbill_auctions
    const savedAuctions = closed.length > 0
      ? await saveToSupabase(supabase, 'tbill_auctions', closed.map(a => ({
          auction_date: a.auction_date,
          tenor: a.tenor,
          cutoff_yield: a.cutoff_yield,
          cutoff_price: a.cutoff_price,
          maturity_date: a.maturity_date,
          scraped_at: new Date().toISOString(),
        })), 'auction_date,tenor')
      : 0;

    // Save upcoming to tbill_upcoming
    const savedUpcoming = upcoming.length > 0
      ? await saveToSupabase(supabase, 'tbill_upcoming', upcoming.map(a => ({
          auction_date: a.auction_date,
          issue_date: a.issue_date,
          maturity_date: a.maturity_date,
          tenor: a.tenor,
          code: a.code,
          status: a.status,
          updated_at: new Date().toISOString(),
        })), 'auction_date,tenor')
      : 0;

    return Response.json({
      success: true,
      source: 'ilovessb.com',
      closed: { found: closed.length, saved: savedAuctions },
      upcoming: { found: upcoming.length, saved: savedUpcoming },
      sample: { closed: closed.slice(0, 2), upcoming: upcoming.slice(0, 2) },
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}