// app/api/mas/route.js
// Serves T-Bill auction and upcoming data from Supabase
// Security: read-only, no user input accepted, errors sanitised
// Fallback to hardcoded data if Supabase is unavailable

import { createClient } from '@supabase/supabase-js';

export const revalidate = 0;

const MONTHS = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };

function dateToSortKey(dateStr) {
  if (!dateStr) return 0;
  const m = dateStr.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (!m) return 0;
  return parseInt(m[3]) * 10000 + (MONTHS[m[2]] || 0) * 100 + parseInt(m[1]);
}

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

function normalise(r) {
  return {
    auctionDate: r.auction_date,
    tenor: r.tenor,
    cutoffYield: r.cutoff_yield,
    cutoffPrice: r.cutoff_price || '',
    maturityDate: r.maturity_date || '',
  };
}

const FALLBACK_DATA = [
  { auction_date: '04 Jun 2026', tenor: '6-month', cutoff_yield: '1.48%', cutoff_price: '99.262', maturity_date: '08 Dec 2026' },
  { auction_date: '21 May 2026', tenor: '6-month', cutoff_yield: '1.45%', cutoff_price: '99.283', maturity_date: '19 Nov 2026' },
  { auction_date: '16 Apr 2026', tenor: '1-year', cutoff_yield: '1.46%', cutoff_price: '98.544', maturity_date: '20 Apr 2027' },
  { auction_date: '09 Apr 2026', tenor: '6-month', cutoff_yield: '1.47%', cutoff_price: '99.281', maturity_date: '08 Oct 2026' },
  { auction_date: '26 Mar 2026', tenor: '6-month', cutoff_yield: '1.46%', cutoff_price: '99.284', maturity_date: '25 Sep 2026' },
  { auction_date: '12 Mar 2026', tenor: '6-month', cutoff_yield: '1.37%', cutoff_price: '99.306', maturity_date: '10 Sep 2026' },
  { auction_date: '26 Feb 2026', tenor: '6-month', cutoff_yield: '1.36%', cutoff_price: '99.311', maturity_date: '27 Aug 2026' },
  { auction_date: '12 Feb 2026', tenor: '6-month', cutoff_yield: '1.36%', cutoff_price: '99.311', maturity_date: '13 Aug 2026' },
  { auction_date: '29 Jan 2026', tenor: '6-month', cutoff_yield: '1.37%', cutoff_price: '99.306', maturity_date: '30 Jul 2026' },
  { auction_date: '15 Jan 2026', tenor: '6-month', cutoff_yield: '1.39%', cutoff_price: '99.296', maturity_date: '16 Jul 2026' },
];

const FALLBACK_UPCOMING = [
  { auction_date: '18 Jun 2026', issue_date: '23 Jun 2026', maturity_date: '22 Dec 2026', tenor: '6-month', code: 'BS26112T' },
  { auction_date: '02 Jul 2026', issue_date: '07 Jul 2026', maturity_date: '05 Jan 2027', tenor: '6-month', code: 'BS26113X' },
  { auction_date: '16 Jul 2026', issue_date: '21 Jul 2026', maturity_date: '19 Jan 2027', tenor: '6-month', code: 'BS26114W' },
];

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'auctions';

  // Validate type parameter
  if (!['auctions', 'upcoming', 'yields'].includes(type)) {
    return Response.json({ error: 'Invalid type parameter' }, { status: 400 });
  }

  const supabase = getSupabaseClient();

  // ── Upcoming auctions ─────────────────────────────────────────────────────
  if (type === 'upcoming') {
    if (supabase) {
      try {
        const { data: rows, error } = await supabase
          .from('tbill_upcoming')
          .select('auction_date,issue_date,maturity_date,tenor,code')
          .limit(10);

        if (!error && rows?.length > 0) {
          const todayKey = dateToSortKey(
            new Date().toLocaleDateString('en-SG', { day: '2-digit', month: 'short', year: 'numeric' })
              .replace(',', '')
          );
          // Filter future dates and sort ascending
          const future = rows
            .filter(r => dateToSortKey(r.auction_date) >= todayKey)
            .sort((a, b) => dateToSortKey(a.auction_date) - dateToSortKey(b.auction_date));

          return Response.json({ success: true, data: future, source: 'supabase' });
        }
      } catch (err) {
        console.error('Upcoming Supabase error:', err.message);
      }
    }
    // Fallback
    return Response.json({ success: true, data: FALLBACK_UPCOMING, source: 'fallback' });
  }

  // ── Closed auctions ───────────────────────────────────────────────────────
  let data = [];
  let source = 'fallback';

  if (supabase) {
    try {
      const { data: rows, error } = await supabase
        .from('tbill_auctions')
        .select('auction_date,tenor,cutoff_yield,cutoff_price,maturity_date')
        .limit(100);

      if (!error && rows?.length > 0) {
        data = rows
          .map(normalise)
          .sort((a, b) => dateToSortKey(b.auctionDate) - dateToSortKey(a.auctionDate));
        source = 'supabase';
      }
    } catch (err) {
      console.error('Auctions Supabase error:', err.message);
    }
  }

  if (data.length === 0) {
    data = FALLBACK_DATA.map(normalise);
    source = 'fallback';
  }

  if (type === 'yields') {
    const yields = data
      .map(d => ({ date: d.auctionDate, tenor: d.tenor, yield: parseFloat((d.cutoffYield || '0').replace('%', '')) }))
      .filter(d => d.yield > 0);
    return Response.json({ success: true, data: yields, source });
  }

  const latest6m = data.find(d => d.tenor === '6-month');
  return Response.json({
    success: true,
    data,
    latestYield: latest6m?.cutoffYield?.replace('%', '') || '1.48',
    source,
    lastUpdated: source === 'supabase' ? 'Live' : 'Jun 2026',
  });
}