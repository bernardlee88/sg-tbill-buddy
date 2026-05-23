// app/api/mas/route.js
// Fetches T-Bill auction data from MAS
// MAS provides data via their public API at eservices.mas.gov.sg

export const revalidate = 3600; // Cache for 1 hour

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'auctions';

  try {
    if (type === 'auctions') {
      // MAS Securities Auction API
      const res = await fetch(
        'https://eservices.mas.gov.sg/api/action/datastore/search.json?resource_id=9a0bf149-308c-4bd2-832d-76c8e6cb47ed&limit=20&sort=auction_date%20desc',
        {
          headers: { 'User-Agent': 'SGTBillBuddy/1.0' },
          next: { revalidate: 3600 },
        }
      );

      if (!res.ok) throw new Error('MAS API error: ' + res.status);
      const data = await res.json();
      const records = data?.result?.records || [];

      // Filter for T-Bills only (6-month and 1-year)
      const tbills = records
        .filter(r => r.product_type === 'T-Bill' || r.bill_type === 'T-Bill' ||
          (r.product && r.product.includes('T-Bill')))
        .slice(0, 15)
        .map(r => ({
          auctionDate: r.auction_date || r.issue_date || '',
          maturityDate: r.maturity_date || '',
          tenor: r.tenor || r.maturity || '',
          cutoffYield: r.cutoff_yield || r.yield || '',
          cutoffPrice: r.cutoff_price || '',
          totalAmount: r.total_amount || r.amount || '',
          isin: r.isin || r.security_code || '',
        }));

      return Response.json({ success: true, data: tbills, source: 'MAS eServices API' });
    }

    if (type === 'yields') {
      // Historical yields
      const res = await fetch(
        'https://eservices.mas.gov.sg/api/action/datastore/search.json?resource_id=9a0bf149-308c-4bd2-832d-76c8e6cb47ed&limit=30&sort=auction_date%20desc&filters=%7B%22product_type%22%3A%22T-Bill%22%7D',
        {
          headers: { 'User-Agent': 'SGTBillBuddy/1.0' },
          next: { revalidate: 3600 },
        }
      );

      if (!res.ok) throw new Error('MAS API error: ' + res.status);
      const data = await res.json();
      const records = data?.result?.records || [];

      const yields = records.map(r => ({
        date: r.auction_date || r.issue_date || '',
        tenor: r.tenor || '',
        yield: parseFloat(r.cutoff_yield || r.yield || 0),
      })).filter(r => r.yield > 0);

      return Response.json({ success: true, data: yields });
    }

    return Response.json({ error: 'Unknown type' }, { status: 400 });

  } catch (err) {
    console.error('MAS API error:', err.message);

    // Return fallback data so app still works
    const fallbackAuctions = [
      {
        auctionDate: 'Check MAS website',
        tenor: '6-month',
        cutoffYield: '3.48%',
        note: 'Live data temporarily unavailable — check mas.gov.sg for latest',
      },
    ];

    return Response.json({
      success: false,
      data: fallbackAuctions,
      error: 'Could not fetch live MAS data. Showing cached/sample data.',
      fallback: true,
    });
  }
}