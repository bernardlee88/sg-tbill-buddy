'use client';

import { useState, useEffect } from 'react';

export default function AuctionsPage() {
  const [auctions, setAuctions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/mas?type=auctions')
      .then(r => r.json())
      .then(data => {
        setAuctions(data.data || []);
        setLoading(false);
      })
      .catch(() => {
        setError('Could not load auction data. Please check mas.gov.sg directly.');
        setLoading(false);
      });
  }, []);

  return (
    <>
      <div className="page-header">
        <div className="page-header-inner">
          <h1>T-Bill Auctions</h1>
          <p>Recent and upcoming Singapore T-Bill auctions sourced from MAS eServices.</p>
        </div>
      </div>

      <section className="section">
        <div className="container">

          {/* MAS link callout */}
          <div style={{ background: 'white', border: '1px solid var(--gray-200)', borderLeft: '4px solid var(--red)', borderRadius: '8px', padding: '16px 20px', marginBottom: '32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <div style={{ fontWeight: '600', fontSize: '14px', marginBottom: '4px' }}>📋 Always verify with MAS directly</div>
              <div style={{ fontSize: '13px', color: 'var(--gray-600)' }}>For the most accurate and up-to-date auction information, check the official MAS website.</div>
            </div>
            <a href="https://www.mas.gov.sg/bonds-and-bills/singapore-government-t-bills-information-for-individuals" target="_blank" rel="noopener" className="btn-primary" style={{ whiteSpace: 'nowrap' }}>
              View on MAS →
            </a>
          </div>

          {loading && (
            <div style={{ textAlign: 'center', padding: '60px', color: 'var(--gray-400)' }}>
              <div style={{ fontSize: '32px', marginBottom: '12px' }}>⏳</div>
              Loading auction data from MAS...
            </div>
          )}

          {error && (
            <div className="disclaimer" style={{ marginBottom: '24px' }}>⚠️ {error}</div>
          )}

          {/* Last updated note */}
          {!loading && auctions.length > 0 && auctions[0]?.lastUpdated && (
            <div style={{ fontSize: '12px', color: 'var(--gray-400)', marginBottom: '16px' }}>
              Data last updated: {auctions[0].lastUpdated} · Source: MAS Treasury Bills Statistics
            </div>
          )}

          {!loading && auctions.length > 0 && (
            <div className="card" style={{ padding: '0', overflow: 'hidden' }}>
              <div style={{ padding: '20px 24px', borderBottom: '1px solid var(--gray-200)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h2 style={{ fontSize: '18px' }}>Recent Auctions</h2>
                <span className="badge badge-red">{auctions.length} results</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Auction Date</th>
                      <th>Tenor</th>
                      <th>Cut-off Yield</th>
                      <th>Cut-off Price</th>
                      <th>Maturity Date</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {auctions.map((auction, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: '500' }}>{auction.auctionDate}</td>
                        <td><span className="badge badge-red">{auction.tenor || '6-month'}</span></td>
                        <td style={{ fontWeight: '700', color: 'var(--red)' }}>
                          {auction.cutoffYield || '—'}
                        </td>
                        <td>{auction.cutoffPrice || '—'}</td>
                        <td style={{ color: 'var(--gray-600)' }}>{auction.maturityDate || '—'}</td>
                        <td>
                          <a
                            href={`/calculator?yield=${(auction.cutoffYield || '').replace('%', '')}&tenor=${auction.tenor === '1-year' ? '364' : '182'}`}
                            style={{ fontSize: '12px', color: 'var(--red)', fontWeight: '600', textDecoration: 'none' }}
                          >
                            Calculate →
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* How auctions work */}
          <div style={{ marginTop: '48px' }}>
            <div className="section-label">How It Works</div>
            <h2 className="section-title" style={{ fontSize: '28px', marginBottom: '28px' }}>Understanding T-Bill Auctions</h2>
            <div className="card-grid card-grid-2">
              {[
                {
                  step: '01',
                  title: 'Uniform Price Auction',
                  desc: 'MAS conducts a uniform-price auction. All successful bidders receive the same cut-off yield, regardless of the yield they bid.',
                },
                {
                  step: '02',
                  title: 'Competitive vs Non-Competitive',
                  desc: 'Retail investors typically submit non-competitive bids — you accept whatever cut-off yield is set. You are guaranteed allocation.',
                },
                {
                  step: '03',
                  title: 'Cut-off Yield',
                  desc: 'The cut-off yield is determined by demand. Higher demand = lower yield. Lower demand = higher yield. Recent yields have been around 3-4% p.a.',
                },
                {
                  step: '04',
                  title: 'Application Deadline',
                  desc: 'Apply by the closing date (usually the Thursday before auction). Results are announced the following day. Funds are debited on issue date.',
                },
              ].map((item, i) => (
                <div key={i} className="card" style={{ display: 'flex', gap: '16px' }}>
                  <div style={{ fontFamily: 'Playfair Display, serif', fontSize: '32px', fontWeight: '900', color: 'var(--red)', opacity: 0.3, lineHeight: '1', flexShrink: 0 }}>{item.step}</div>
                  <div>
                    <div style={{ fontFamily: 'Playfair Display, serif', fontSize: '17px', fontWeight: '700', marginBottom: '8px' }}>{item.title}</div>
                    <div style={{ fontSize: '14px', color: 'var(--gray-600)', lineHeight: '1.6' }}>{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: '32px' }} id="donate">
            <div className="donate-bar">
              <div>
                <div className="donate-text" style={{ fontWeight: '600', marginBottom: '4px' }}>☕ Found this useful?</div>
                <div className="donate-text">Help keep SG T-Bill Buddy free and up to date.</div>
              </div>
              <a href="https://ko-fi.com" target="_blank" rel="noopener" className="btn-donate">Support This Tool</a>
            </div>
          </div>

          <div style={{ marginTop: '24px' }}>
            <div className="disclaimer">
              Auction data is sourced from MAS eServices API. While we strive for accuracy, always verify with the official MAS website before making investment decisions.
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
