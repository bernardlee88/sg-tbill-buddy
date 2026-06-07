'use client';

import { useState, useEffect } from 'react';

function dateToSortKey(dateStr) {
  if (!dateStr) return 0;
  const months = { Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12 };
  const m = dateStr.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (!m) return 0;
  return parseInt(m[3]) * 10000 + (months[m[2]] || 0) * 100 + parseInt(m[1]);
}

function DaysUntil({ dateStr }) {
  if (!dateStr) return null;
  const months = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
  const m = dateStr.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
  if (!m) return null;
  const target = new Date(parseInt(m[3]), months[m[2]], parseInt(m[1]));
  const today = new Date();
  today.setHours(0,0,0,0);
  const diff = Math.ceil((target - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return null;
  if (diff === 0) return <span style={{ color: '#DC2626', fontWeight: '700', fontSize: '11px' }}>Today</span>;
  if (diff === 1) return <span style={{ color: '#D97706', fontWeight: '700', fontSize: '11px' }}>Tomorrow</span>;
  return <span style={{ color: '#64748B', fontSize: '11px' }}>{diff} days away</span>;
}

export default function AuctionsPage() {
  const [auctions, setAuctions] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [activeFilter, setActiveFilter] = useState('all');

  useEffect(() => {
    Promise.all([
      fetch('/api/mas?type=auctions').then(r => r.json()),
      fetch('/api/mas?type=upcoming').then(r => r.json()),
    ]).then(([auctionData, upcomingData]) => {
      setAuctions(auctionData.data || []);
      setUpcoming(upcomingData.data || []);
      setLoading(false);
    }).catch(() => {
      setError('Could not load auction data.');
      setLoading(false);
    });
  }, []);

  const filteredAuctions = activeFilter === 'all'
    ? auctions
    : auctions.filter(a => a.tenor === activeFilter);

  const latest = auctions[0];

  return (
    <>
      {/* Hero */}
      <div style={{ background: 'linear-gradient(135deg, #1a0a0a 0%, #2D0A0A 50%, #1a0a0a 100%)', padding: '48px 24px 56px', color: 'white', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(ellipse at 20% 50%, rgba(220,38,38,0.12) 0%, transparent 60%), radial-gradient(ellipse at 80% 50%, rgba(220,38,38,0.08) 0%, transparent 60%)' }} />
        <div style={{ position: 'absolute', bottom: '-2px', left: 0, right: 0, height: '40px', background: '#F8FAFC', clipPath: 'ellipse(55% 100% at 50% 100%)' }} />
        <div className="container" style={{ position: 'relative', zIndex: 1 }}>
          <div style={{ fontSize: '11px', fontWeight: '700', letterSpacing: '0.12em', textTransform: 'uppercase', color: '#FCA5A5', marginBottom: '10px' }}>🏛️ MAS T-Bill Auctions</div>
          <h1 style={{ fontFamily: 'Playfair Display, serif', fontSize: 'clamp(28px, 5vw, 42px)', fontWeight: '700', marginBottom: '12px', lineHeight: '1.2' }}>
            Auction Dates & Results
          </h1>
          <p style={{ color: '#94A3B8', fontSize: '15px', maxWidth: '500px', lineHeight: '1.7', marginBottom: '24px' }}>
            Upcoming auction schedule and cut-off yields from recent T-Bill auctions. All data sourced from MAS via ilovessb.com.
          </p>
          {latest && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: '16px', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: '12px', padding: '14px 20px', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: '11px', color: '#94A3B8', marginBottom: '2px' }}>Latest Cut-off Yield</div>
                <div style={{ fontFamily: 'Playfair Display, serif', fontSize: '28px', fontWeight: '700', color: 'white' }}>{latest.cutoffYield}</div>
              </div>
              <div style={{ width: '1px', height: '36px', background: 'rgba(255,255,255,0.15)' }} />
              <div>
                <div style={{ fontSize: '11px', color: '#94A3B8', marginBottom: '2px' }}>Auction Date</div>
                <div style={{ fontSize: '14px', fontWeight: '600', color: 'white' }}>{latest.auctionDate}</div>
              </div>
              <div style={{ width: '1px', height: '36px', background: 'rgba(255,255,255,0.15)' }} />
              <div>
                <div style={{ fontSize: '11px', color: '#94A3B8', marginBottom: '2px' }}>Tenor</div>
                <div style={{ fontSize: '14px', fontWeight: '600', color: 'white' }}>{latest.tenor}</div>
              </div>
            </div>
          )}
        </div>
      </div>

      <section style={{ padding: '32px 0 64px', background: '#F8FAFC' }}>
        <div className="container">

          {/* Upcoming auctions */}
          {upcoming.length > 0 && (
            <div style={{ marginBottom: '32px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
                <div style={{ width: '10px', height: '10px', borderRadius: '50%', background: 'var(--red)' }} />
                <span style={{ fontSize: '12px', fontWeight: '700', color: 'var(--red)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>Upcoming Auctions</span>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '12px', marginBottom: '12px' }}>
                {upcoming.map((a, i) => (
                  <div key={i} style={{
                    background: 'white', borderRadius: '14px', padding: '18px',
                    border: i === 0 ? '2px solid var(--red)' : '1px solid #E2E8F0',
                    position: 'relative', overflow: 'hidden',
                  }}>
                    {i === 0 && (
                      <div style={{ position: 'absolute', top: 0, left: 0, right: 0, height: '3px', background: 'var(--red)' }} />
                    )}
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                      <div>
                        <div style={{ fontSize: '11px', color: '#94A3B8', marginBottom: '3px' }}>Auction Date</div>
                        <div style={{ fontFamily: 'Playfair Display, serif', fontSize: '17px', fontWeight: '700', color: '#0F172A' }}>{a.auction_date}</div>
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px' }}>
                        <span style={{ background: a.tenor === '1-year' ? '#FEF3C7' : '#FEE2E2', color: a.tenor === '1-year' ? '#92400E' : '#991B1B', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '20px', textTransform: 'uppercase' }}>{a.tenor}</span>
                        <DaysUntil dateStr={a.auction_date} />
                      </div>
                    </div>
                    {a.issue_date && (
                      <div style={{ fontSize: '12px', color: '#64748B', marginBottom: '4px' }}>
                        Issue date: <strong>{a.issue_date}</strong>
                      </div>
                    )}
                    {a.code && (
                      <div style={{ fontSize: '11px', color: '#94A3B8', marginBottom: '12px' }}>Code: {a.code}</div>
                    )}
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <a href="/guide" style={{ flex: 1, textAlign: 'center', padding: '7px', borderRadius: '8px', background: i === 0 ? 'var(--red)' : '#F1F5F9', color: i === 0 ? 'white' : '#64748B', textDecoration: 'none', fontSize: '12px', fontWeight: '600' }}>
                        How to Apply →
                      </a>
                    </div>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: '11px', color: '#94A3B8', lineHeight: '1.6' }}>
                ⚠️ Source: ilovessb.com via MAS Issuance Calendar. Cash application deadline typically 9pm the day before auction. Check with your bank for CPF/SRS deadlines. Always verify with <a href="https://www.mas.gov.sg" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--red)' }}>MAS directly</a>.
              </div>
            </div>
          )}

          {/* MAS callout */}
          <div style={{ background: 'white', border: '1px solid #E2E8F0', borderLeft: '4px solid var(--red)', borderRadius: '0 12px 12px 0', padding: '16px 20px', marginBottom: '28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
            <div>
              <div style={{ fontWeight: '600', fontSize: '14px', color: '#0F172A', marginBottom: '3px' }}>Always verify with MAS directly</div>
              <div style={{ fontSize: '13px', color: '#64748B' }}>For official auction schedules and results, check the MAS website.</div>
            </div>
            <a href="https://www.mas.gov.sg/bonds-and-bills/singapore-government-t-bills-information-for-individuals" target="_blank" rel="noopener noreferrer"
              style={{ padding: '10px 18px', background: 'var(--red)', color: 'white', borderRadius: '8px', textDecoration: 'none', fontSize: '13px', fontWeight: '600', whiteSpace: 'nowrap' }}>
              View on MAS →
            </a>
          </div>

          {/* Loading */}
          {loading && (
            <div style={{ textAlign: 'center', padding: '60px', color: '#94A3B8' }}>
              <div style={{ fontSize: '28px', marginBottom: '10px' }}>⏳</div>
              Loading auction data...
            </div>
          )}

          {error && (
            <div style={{ background: '#FEF2F2', border: '1px solid #FECACA', borderRadius: '8px', padding: '14px 18px', color: '#DC2626', fontSize: '13px', marginBottom: '20px' }}>
              ⚠️ {error}
            </div>
          )}

          {/* Auction results table */}
          {!loading && auctions.length > 0 && (
            <div style={{ background: 'white', borderRadius: '16px', overflow: 'hidden', border: '1px solid #E2E8F0' }}>
              <div style={{ padding: '18px 22px', borderBottom: '1px solid #E2E8F0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
                <div>
                  <h2 style={{ fontFamily: 'Playfair Display, serif', fontSize: '18px', fontWeight: '700', color: '#0F172A', marginBottom: '2px' }}>Recent Auctions</h2>
                  <div style={{ fontSize: '11px', color: '#94A3B8' }}>{auctions.length} results · sorted by date</div>
                </div>
                <div style={{ display: 'flex', gap: '6px' }}>
                  {['all', '6-month', '1-year'].map(f => (
                    <button key={f} onClick={() => setActiveFilter(f)}
                      style={{ padding: '6px 12px', borderRadius: '20px', border: '1.5px solid', borderColor: activeFilter === f ? 'var(--red)' : '#E2E8F0', background: activeFilter === f ? 'var(--red)' : 'white', color: activeFilter === f ? 'white' : '#64748B', fontSize: '12px', fontWeight: '600', cursor: 'pointer', fontFamily: 'Inter, sans-serif' }}>
                      {f === 'all' ? 'All' : f}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px', minWidth: '500px' }}>
                  <thead>
                    <tr style={{ background: '#F8FAFC' }}>
                      {['Auction Date', 'Tenor', 'Cut-off Yield', 'Cut-off Price', 'Maturity Date', ''].map((h, i) => (
                        <th key={i} style={{ padding: '10px 16px', textAlign: i === 0 ? 'left' : i === 5 ? 'right' : 'center', fontSize: '10px', fontWeight: '700', letterSpacing: '0.08em', textTransform: 'uppercase', color: '#94A3B8', borderBottom: '1px solid #E2E8F0', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredAuctions.map((auction, i) => (
                      <tr key={i} style={{ borderBottom: '1px solid #F1F5F9' }}>
                        <td style={{ padding: '13px 16px', fontWeight: '600', color: '#0F172A', whiteSpace: 'nowrap' }}>{auction.auctionDate}</td>
                        <td style={{ padding: '13px 16px', textAlign: 'center' }}>
                          <span style={{ background: auction.tenor === '1-year' ? '#FEF3C7' : '#FEE2E2', color: auction.tenor === '1-year' ? '#92400E' : '#991B1B', fontSize: '10px', fontWeight: '700', padding: '2px 8px', borderRadius: '20px', textTransform: 'uppercase' }}>
                            {auction.tenor || '6-month'}
                          </span>
                        </td>
                        <td style={{ padding: '13px 16px', textAlign: 'center', fontWeight: '800', color: 'var(--red)', fontFamily: 'Playfair Display, serif', fontSize: '15px' }}>{auction.cutoffYield || '—'}</td>
                        <td style={{ padding: '13px 16px', textAlign: 'center', color: '#64748B' }}>{auction.cutoffPrice || '—'}</td>
                        <td style={{ padding: '13px 16px', textAlign: 'center', color: '#64748B', whiteSpace: 'nowrap' }}>{auction.maturityDate || '—'}</td>
                        <td style={{ padding: '13px 16px', textAlign: 'right' }}>
                          <a href={`/calculator?yield=${(auction.cutoffYield || '').replace('%', '')}&tenor=${auction.tenor === '1-year' ? '364' : '182'}`}
                            style={{ fontSize: '12px', color: 'var(--red)', fontWeight: '600', textDecoration: 'none', whiteSpace: 'nowrap' }}>
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
          <div style={{ marginTop: '40px', marginBottom: '32px' }}>
            <div style={{ fontSize: '11px', fontWeight: '700', color: '#94A3B8', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: '8px' }}>How It Works</div>
            <h2 style={{ fontFamily: 'Playfair Display, serif', fontSize: '26px', fontWeight: '700', color: '#0F172A', marginBottom: '20px' }}>Understanding T-Bill Auctions</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: '14px' }}>
              {[
                { step: '01', title: 'Uniform Price Auction', desc: 'MAS uses a uniform-price auction. All successful bidders receive the same cut-off yield, regardless of what they bid.' },
                { step: '02', title: 'Non-Competitive Bids', desc: 'Retail investors submit non-competitive bids — you accept whatever cut-off yield is set and are guaranteed full allocation.' },
                { step: '03', title: 'Cut-off Yield', desc: 'The yield is set by demand. Higher demand means lower yield. Lower demand means higher yield.' },
                { step: '04', title: 'Application Deadline', desc: 'Apply by 9pm the day before auction for cash applications. CPF/SRS deadlines vary by bank — check in advance.' },
              ].map((item, i) => (
                <div key={i} style={{ background: 'white', borderRadius: '14px', padding: '20px', border: '1px solid #E2E8F0', display: 'flex', gap: '14px' }}>
                  <div style={{ fontFamily: 'Playfair Display, serif', fontSize: '28px', fontWeight: '700', color: 'var(--red)', opacity: 0.25, lineHeight: '1', flexShrink: 0 }}>{item.step}</div>
                  <div>
                    <div style={{ fontSize: '14px', fontWeight: '700', color: '#0F172A', marginBottom: '6px', fontFamily: 'Playfair Display, serif' }}>{item.title}</div>
                    <div style={{ fontSize: '13px', color: '#64748B', lineHeight: '1.6' }}>{item.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Donate */}
          <div style={{ background: 'linear-gradient(135deg, #FFF5F5, #FEF2F2)', border: '1px solid #FECACA', borderRadius: '14px', padding: '24px 28px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '16px', marginBottom: '24px' }}>
            <div>
              <div style={{ fontWeight: '700', fontSize: '15px', color: '#0F172A', marginBottom: '4px' }}>☕ Found this useful?</div>
              <div style={{ fontSize: '13px', color: '#64748B' }}>Help keep SG T-Bill Buddy free and up to date.</div>
            </div>
            <a href="https://ko-fi.com" target="_blank" rel="noopener noreferrer"
              style={{ padding: '10px 20px', background: 'var(--red)', color: 'white', borderRadius: '10px', textDecoration: 'none', fontSize: '13px', fontWeight: '600' }}>
              Support This Tool
            </a>
          </div>

          {/* Disclaimer */}
          <div style={{ background: '#F8FAFC', borderLeft: '3px solid #CBD5E1', borderRadius: '0 8px 8px 0', padding: '12px 16px', fontSize: '11px', color: '#64748B', lineHeight: '1.7' }}>
            Auction data is sourced from MAS via ilovessb.com. While we strive for accuracy, always verify with the <a href="https://www.mas.gov.sg" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--red)' }}>official MAS website</a> before making any investment decisions. This tool does not constitute financial advice.
          </div>

        </div>
      </section>
    </>
  );
}
