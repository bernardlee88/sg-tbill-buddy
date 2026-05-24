// app/api/mas/route.js
// Serves T-Bill auction data
// Primary: reads from Supabase tbill_auctions table (populated by /api/scrape-mas)
// Fallback: hardcoded recent data if Supabase is empty

import { createClient } from '@supabase/supabase-js';

export const revalidate = 3600;

function getSupabaseClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

// Verified from MAS — May 2026
// Only used if Supabase has no data yet
const FALLBACK_DATA = [
  { auction_date: '21 May 2026', tenor: '6-month', cutoff_yield: '1.45%', cutoff_price: '99.283', maturity_date: '19 Nov 2026' },
  { auction_date: '8 May 2026', tenor: '6-month', cutoff_yield: '1.44%', cutoff_price: '99.287', maturity_date: '5 Nov 2026' },
  { auction_date: '24 Apr 2026', tenor: '1-year', cutoff_yield: '1.46%', cutoff_price: '98.549', maturity_date: '23 Apr 2027' },
  { auction_date: '9 Apr 2026', tenor: '6-month', cutoff_yield: '1.47%', cutoff_price: '99.281', maturity_date: '8 Oct 2026' },
  { auction_date: '26 Mar 2026', tenor: '6-month', cutoff_yield: '1.43%', cutoff_price: '99.287', maturity_date: '25 Sep 2026' },
  { auction_date: '12 Mar 2026', tenor: '1-year', cutoff_yield: '1.39%', cutoff_price: '98.619', maturity_date: '11 Mar 2027' },
  { auction_date: '26 Feb 2026', tenor: '6-month', cutoff_yield: '1.38%', cutoff_price: '99.311', maturity_date: '27 Aug 2026' },
  { auction_date: '12 Feb 2026', tenor: '6-month', cutoff_yield: '1.40%', cutoff_price: '99.301', maturity_date: '13 Aug 2026' },
  { auction_date: '29 Jan 2026', tenor: '1-year', cutoff_yield: '1.41%', cutoff_price: '98.601', maturity_date: '28 Jan 2027' },
  { auction_date: '15 Jan 2026', tenor: '6-month', cutoff_yield: '1.40%', cutoff_price: '99.301', maturity_date: '16 Jul 2026' },
];

function normalise(r) {
  return {
    auctionDate: r.auction_date,
    tenor: r.tenor,
    cutoffYield: r.cutoff_yield,
    cutoffPrice: r.cutoff_price || '',
    maturityDate: r.maturity_date || '',
  };
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'auctions';

  let data = [];
  let source = 'fallback';

  // Try Supabase first
  try {
    const supabase = getSupabaseClient();
    if (supabase) {
      const { data: rows, error } = await supabase
        .from('tbill_auctions')
        .select('*')
        .order('auction_date', { ascending: false })
        .limit(20);

      if (!error && rows && rows.length > 0) {
        data = rows.map(normalise);
        source = 'supabase';
        console.log('Serving', data.length, 'auctions from Supabase');
      }
    }
  } catch (err) {
    console.error('Supabase read error:', err.message);
  }

  // Fall back to hardcoded data
  if (data.length === 0) {
    data = FALLBACK_DATA.map(r => ({
      auctionDate: r.auction_date,
      tenor: r.tenor,
      cutoffYield: r.cutoff_yield,
      cutoffPrice: r.cutoff_price,
      maturityDate: r.maturity_date,
    }));
    source = 'fallback';
    console.log('Serving fallback auction data');
  }

  if (type === 'yields') {
    const yields = data.map(d => ({
      date: d.auctionDate,
      tenor: d.tenor,
      yield: parseFloat((d.cutoffYield || '0').replace('%', '')),
    })).filter(d => d.yield > 0);
    return Response.json({ success: true, data: yields, source });
  }

  // Get latest yield for home page stat
  const latest6m = data.find(d => d.tenor === '6-month');
  const latestYield = latest6m?.cutoffYield?.replace('%', '') || '1.45';

  return Response.json({
    success: true,
    data,
    latestYield,
    source,
    lastUpdated: source === 'supabase' ? 'Live from MAS' : 'May 2026',
  });
}