// app/api/scrape-mas/route.js
// Scrapes T-Bill auction results from Growbeansprout
// Cron: every Thursday at 6pm SGT (10:00 UTC)

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

// Use Browserless /content endpoint — simpler than /function, returns page text directly
async function fetchPageText(targetUrl) {
  const apiKey = process.env.BROWSERLESS_API_KEY;
  if (!apiKey) throw new Error('Missing BROWSERLESS_API_KEY');

  const res = await fetch(
    'https://chrome.browserless.io/content?token=' + apiKey,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: targetUrl,
        waitFor: 2000,
      }),
    }
  );

  if (!res.ok) throw new Error('Browserless error: ' + res.status);

  const html = await res.text();
  // Strip HTML tags to get plain text
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 5000);
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

function calcCutoffPrice(yieldPct, tenorDays) {
  const y = parseFloat(yieldPct) / 100;
  const t = parseInt(tenorDays);
  if (isNaN(y) || isNaN(t) || y <= 0) return null;
  return (100 - 100 * y * t / 365).toFixed(3);
}

// Build candidate URLs for a date — Growbeansprout uses inconsistent formats
function buildUrls(dateStr) {
  const parts = dateStr.split(' ');
  if (parts.length !== 3) return [];
  const day = parseInt(parts[0]).toString(); // no leading zero
  const mon = parts[1].toLowerCase();
  const year = parts[2];
  const fullMonths = {
    jan:'january', feb:'february', mar:'march', apr:'april',
    may:'may', jun:'june', jul:'july', aug:'august',
    sep:'september', oct:'october', nov:'november', dec:'december'
  };
  const full = fullMonths[mon] || mon;
  const base = 'https://growbeansprout.com/t-bill-allotment-';
  return [
    base + day + '-' + full + '-' + year,
    base + day + '-' + mon + '-' + year,
  ];
}

// Known MAS T-bill auction dates
function getAuctionDates() {
  return [
    // 6-month 2025
    '07 Jan 2025','21 Jan 2025','04 Feb 2025','18 Feb 2025',
    '04 Mar 2025','18 Mar 2025','01 Apr 2025','15 Apr 2025',
    '29 Apr 2025','13 May 2025','27 May 2025','10 Jun 2025',
    '24 Jun 2025','08 Jul 2025','22 Jul 2025','05 Aug 2025',
    '19 Aug 2025','02 Sep 2025','16 Sep 2025','30 Sep 2025',
    '14 Oct 2025','28 Oct 2025','11 Nov 2025','25 Nov 2025',
    '09 Dec 2025','23 Dec 2025',
    // 1-year 2025
    '28 Jan 2025','22 Apr 2025','29 Jul 2025','21 Oct 2025',
    // 6-month 2026
    '06 Jan 2026','15 Jan 2026','20 Jan 2026','29 Jan 2026',
    '12 Feb 2026','26 Feb 2026',
    '12 Mar 2026','26 Mar 2026',
    '09 Apr 2026','23 Apr 2026',
    '07 May 2026','21 May 2026',
    // 1-year 2026
    '16 Apr 2026',
  ];
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

    // Find which dates are missing from Supabase
    const { data: existing } = await supabase
      .from('tbill_auctions')
      .select('auction_date, tenor');

    const existingKeys = new Set((existing || []).map(r => r.auction_date + '|' + r.tenor));
    const allDates = getAuctionDates();
    const missing = allDates.filter(d =>
      !existingKeys.has(d + '|6-month') && !existingKeys.has(d + '|1-year')
    );

    console.log('Missing dates:', missing.length);

    if (missing.length === 0) {
      return Response.json({ success: true, message: 'All auction dates already in database' });
    }

    const auctions = [];

    for (const dateStr of missing.slice(0, 5)) {
      const urls = buildUrls(dateStr);
      let text = null;
      let foundUrl = null;

      for (const url of urls) {
        try {
          console.log('Fetching:', url);
          const t = await fetchPageText(url);
          if (!t.includes('Page not found') && !t.includes('Let s try again')) {
            text = t;
            foundUrl = url;
            break;
          }
        } catch (e) {
          console.log('Failed:', url, e.message);
        }
        await new Promise(r => setTimeout(r, 500));
      }

      if (!text) {
        console.log('No page found for:', dateStr);
        continue;
      }

      console.log('Found page for', dateStr, 'at', foundUrl);

      // Extract cut-off yield
      const yieldMatch =
        text.match(/cut.off yield[^.]{0,80}?([\d.]+)%/i) ||
        text.match(/yield of ([\d.]+)%\s+in the auction/i) ||
        text.match(/yield was at ([\d.]+)%\s+in the auction/i) ||
        text.match(/([\d.]+)%\s+in the auction on/i);

      if (!yieldMatch) {
        console.log('No yield found for:', dateStr);
        continue;
      }

      const yieldVal = parseFloat(yieldMatch[1]);
      if (isNaN(yieldVal) || yieldVal <= 0 || yieldVal >= 15) continue;

      // Determine tenor — 1-year articles mention BY or "1-year" in URL/title
      const tenor = /1.year|one.year|by26/i.test(foundUrl + text.slice(0, 200)) ? '1-year' : '6-month';
      const tenorDays = tenor === '1-year' ? 364 : 182;

      console.log('Parsed:', dateStr, tenor, yieldVal + '%');

      auctions.push({
        auction_date: dateStr,
        tenor,
        cutoff_yield: yieldVal.toFixed(2) + '%',
        cutoff_price: calcCutoffPrice(yieldVal, tenorDays),
        maturity_date: null,
      });

      await new Promise(r => setTimeout(r, 1000));
    }

    if (auctions.length === 0) {
      return Response.json({
        success: false,
        message: 'No new data found for ' + missing.slice(0, 5).join(', '),
        missing,
      });
    }

    const saved = await saveAuctions(supabase, auctions);

    return Response.json({
      success: true,
      scraped: auctions.length,
      saved,
      remaining: Math.max(0, missing.length - auctions.length),
      sample: auctions,
    });

  } catch (err) {
    console.error('Scrape error:', err.message);
    return Response.json({ error: err.message }, { status: 500 });
  }
}