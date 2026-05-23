// app/api/mas/route.js
// Fetches T-Bill auction data from MAS
// Uses MAS eServices API for SGS auction results

export const revalidate = 3600; // Cache for 1 hour

// Hardcoded recent T-Bill data as reliable fallback
// Updated manually when MAS releases new auction results
const FALLBACK_DATA = [
  { auctionDate: '22 May 2026', tenor: '6-month', cutoffYield: '2.80%', cutoffPrice: '98.613', maturityDate: '19 Nov 2026' },
  { auctionDate: '8 May 2026', tenor: '6-month', cutoffYield: '2.84%', cutoffPrice: '98.594', maturityDate: '5 Nov 2026' },
  { auctionDate: '24 Apr 2026', tenor: '1-year', cutoffYield: '2.83%', cutoffPrice: '97.197', maturityDate: '23 Apr 2027' },
  { auctionDate: '10 Apr 2026', tenor: '6-month', cutoffYield: '2.89%', cutoffPrice: '98.567', maturityDate: '9 Oct 2026' },
  { auctionDate: '26 Mar 2026', tenor: '6-month', cutoffYield: '2.95%', cutoffPrice: '98.536', maturityDate: '25 Sep 2026' },
  { auctionDate: '12 Mar 2026', tenor: '1-year', cutoffYield: '2.98%', cutoffPrice: '97.044', maturityDate: '11 Mar 2027' },
  { auctionDate: '26 Feb 2026', tenor: '6-month', cutoffYield: '3.05%', cutoffPrice: '98.488', maturityDate: '27 Aug 2026' },
  { auctionDate: '12 Feb 2026', tenor: '6-month', cutoffYield: '3.10%', cutoffPrice: '98.463', maturityDate: '13 Aug 2026' },
  { auctionDate: '29 Jan 2026', tenor: '1-year', cutoffYield: '3.12%', cutoffPrice: '96.914', maturityDate: '28 Jan 2027' },
  { auctionDate: '15 Jan 2026', tenor: '6-month', cutoffYield: '3.15%', cutoffPrice: '98.450', maturityDate: '16 Jul 2026' },
];

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const type = searchParams.get('type') || 'auctions';

  try {
    // Try MAS API first
    const res = await fetch(
      'https://eservices.mas.gov.sg/api/action/datastore/search.json?resource_id=9a0bf149-308c-4bd2-832d-76c8e6cb47ed&limit=20&sort=issue_date%20desc',
      {
        headers: { 'User-Agent': 'SGTBillBuddy/1.0' },
        next: { revalidate: 3600 },
      }
    );

    if (res.ok) {
      const data = await res.json();
      const records = data?.result?.records || [];

      if (records.length > 0) {
        const tbills = records
          .filter(r => {
            const prod = (r.product_type || r.bill_type || r.product || r.bond_type || '').toLowerCase();
            return prod.includes('t-bill') || prod.includes('tbill') || prod.includes('treasury');
          })
          .slice(0, 15)
          .map(r => ({
            auctionDate: r.auction_date || r.issue_date || '',
            maturityDate: r.maturity_date || '',
            tenor: r.tenor || r.maturity || '6-month',
            cutoffYield: r.cutoff_yield ? r.cutoff_yield + '%' : r.yield || '',
            cutoffPrice: r.cutoff_price || '',
            isin: r.isin || r.security_code || '',
          }));

        if (tbills.length > 0) {
          return Response.json({ success: true, data: tbills, source: 'MAS API' });
        }
      }
    }

    // Fall through to fallback if API returns no usable T-Bill data
    throw new Error('No T-Bill records from API');

  } catch (err) {
    console.log('MAS API unavailable, using fallback data:', err.message);

    if (type === 'yields') {
      const yields = FALLBACK_DATA.map(d => ({
        date: d.auctionDate,
        tenor: d.tenor,
        yield: parseFloat(d.cutoffYield.replace('%', '')),
      }));
      return Response.json({ success: true, data: yields, fallback: true });
    }

    return Response.json({
      success: true,
      data: FALLBACK_DATA,
      fallback: true,
      note: 'Showing recent auction data. Live API temporarily unavailable.',
    });
  }
}