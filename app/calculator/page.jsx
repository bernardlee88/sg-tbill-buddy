'use client';

import { useState, useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import Link from 'next/link';

function calcTBill(principal, yieldPct, tenorDays) {
  const p = parseFloat(principal.toString().replace(/,/g, ''));
  const y = parseFloat(yieldPct) / 100;
  const t = parseInt(tenorDays);
  if (isNaN(p) || isNaN(y) || isNaN(t) || p <= 0 || y <= 0) return null;

  const discount = p * y * (t / 365);
  const purchasePrice = p - discount;
  const profit = discount;
  const effectiveYield = (profit / purchasePrice) * (365 / t) * 100;
  const annualisedReturn = (profit / purchasePrice) * (365 / t) * 100;

  return {
    principal: p,
    purchasePrice,
    maturityValue: p,
    profit,
    effectiveYield,
    annualisedReturn,
    tenorDays: t,
    monthlyEquivalent: profit / (t / 30),
  };
}

function fmt(n, decimals = 2) {
  return new Intl.NumberFormat('en-SG', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(n);
}

const TENOR_OPTIONS = [
  { label: '3-month (91 days)', days: '91' },
  { label: '6-month (182 days)', days: '182' },
  { label: '1-year (364 days)', days: '364' },
];

function CalculatorContent() {
  const searchParams = useSearchParams();
  const [amount, setAmount] = useState('10000');
  const [yieldVal, setYieldVal] = useState('3.48');
  const [tenor, setTenor] = useState('182');

  // Pre-fill from URL params — e.g. /calculator?yield=1.45&tenor=182
  useEffect(() => {
    const y = searchParams.get('yield');
    const t = searchParams.get('tenor');
    const a = searchParams.get('amount');
    if (y) setYieldVal(y);
    if (t) setTenor(t);
    if (a) setAmount(a);
  }, [searchParams]);
  const [compareMode, setCompareMode] = useState(false);
  const [amount2, setAmount2] = useState('50000');
  const [yieldVal2, setYieldVal2] = useState('3.48');
  const [tenor2, setTenor2] = useState('364');

  const result = calcTBill(amount, yieldVal, tenor);
  const result2 = compareMode ? calcTBill(amount2, yieldVal2, tenor2) : null;

  return (
    <>
      <div className="page-header">
        <div className="page-header-inner">
          <h1>T-Bill Calculator</h1>
          <p>Calculate your exact returns before applying. All figures are estimates based on the yield you enter.</p>
        </div>
      </div>

      <section className="section">
        <div className="container">
          <div style={{ display: 'grid', gridTemplateColumns: compareMode ? '1fr 1fr' : '1fr 1fr', gap: '24px', marginBottom: '24px' }}>

            {/* Calculator 1 */}
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <h2 style={{ fontSize: '20px' }}>Your Investment</h2>
                <span className="badge badge-red">Primary</span>
              </div>

              <div className="calc-field">
                <label>Investment Amount (SGD)</label>
                <input
                  type="number"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="10000"
                  min="1000"
                  step="1000"
                />
                <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '4px' }}>Minimum S$1,000 · multiples of S$1,000</div>
              </div>

              <div className="calc-field">
                <label>Expected Cut-off Yield (% p.a.)</label>
                <input
                  type="number"
                  value={yieldVal}
                  onChange={e => setYieldVal(e.target.value)}
                  placeholder="3.48"
                  step="0.01"
                  min="0"
                  max="20"
                />
                <div style={{ fontSize: '11px', color: 'var(--gray-400)', marginTop: '4px' }}>Use the latest cut-off yield as a guide</div>
              </div>

              <div className="calc-field">
                <label>Tenor</label>
                <select value={tenor} onChange={e => setTenor(e.target.value)}>
                  {TENOR_OPTIONS.map(o => (
                    <option key={o.days} value={o.days}>{o.label}</option>
                  ))}
                </select>
              </div>

              {result && (
                <div style={{ marginTop: '20px' }}>
                  <div style={{ fontSize: '11px', fontWeight: '700', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--gray-400)', marginBottom: '12px' }}>Results</div>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <tbody>
                      {[
                        ['You pay (purchase price)', `S$${fmt(result.purchasePrice)}`],
                        ['You receive at maturity', `S$${fmt(result.maturityValue)}`],
                        ['Your profit', `S$${fmt(result.profit)}`],
                        ['Effective yield p.a.', `${fmt(result.effectiveYield, 3)}%`],
                        ['Monthly equivalent', `S$${fmt(result.monthlyEquivalent)}`],
                      ].map(([label, value], i) => (
                        <tr key={i}>
                          <td style={{ padding: '8px 0', fontSize: '13px', color: 'var(--gray-600)', borderBottom: '1px solid var(--gray-200)' }}>{label}</td>
                          <td style={{ padding: '8px 0', fontSize: '14px', fontWeight: '600', textAlign: 'right', borderBottom: '1px solid var(--gray-200)', color: i === 2 ? 'var(--red)' : 'var(--gray-900)' }}>{value}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div style={{ marginTop: '16px', background: 'var(--red-pale)', borderRadius: '8px', padding: '14px', textAlign: 'center' }}>
                    <div style={{ fontSize: '12px', color: 'var(--gray-600)', marginBottom: '4px' }}>Total Profit</div>
                    <div style={{ fontFamily: 'Playfair Display, serif', fontSize: '36px', fontWeight: '700', color: 'var(--red)' }}>S${fmt(result.profit)}</div>
                  </div>
                </div>
              )}
            </div>

            {/* Compare column */}
            {compareMode ? (
              <div className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                  <h2 style={{ fontSize: '20px' }}>Compare With</h2>
                  <span className="badge badge-gold">Compare</span>
                </div>

                <div className="calc-field">
                  <label>Investment Amount (SGD)</label>
                  <input type="number" value={amount2} onChange={e => setAmount2(e.target.value)} placeholder="50000" min="1000" step="1000" />
                </div>
                <div className="calc-field">
                  <label>Expected Cut-off Yield (% p.a.)</label>
                  <input type="number" value={yieldVal2} onChange={e => setYieldVal2(e.target.value)} placeholder="3.48" step="0.01" />
                </div>
                <div className="calc-field">
                  <label>Tenor</label>
                  <select value={tenor2} onChange={e => setTenor2(e.target.value)}>
                    {TENOR_OPTIONS.map(o => (
                      <option key={o.days} value={o.days}>{o.label}</option>
                    ))}
                  </select>
                </div>

                {result2 && (
                  <div style={{ marginTop: '20px' }}>
                    <div style={{ fontSize: '11px', fontWeight: '700', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--gray-400)', marginBottom: '12px' }}>Results</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <tbody>
                        {[
                          ['You pay (purchase price)', `S$${fmt(result2.purchasePrice)}`],
                          ['You receive at maturity', `S$${fmt(result2.maturityValue)}`],
                          ['Your profit', `S$${fmt(result2.profit)}`],
                          ['Effective yield p.a.', `${fmt(result2.effectiveYield, 3)}%`],
                          ['Monthly equivalent', `S$${fmt(result2.monthlyEquivalent)}`],
                        ].map(([label, value], i) => (
                          <tr key={i}>
                            <td style={{ padding: '8px 0', fontSize: '13px', color: 'var(--gray-600)', borderBottom: '1px solid var(--gray-200)' }}>{label}</td>
                            <td style={{ padding: '8px 0', fontSize: '14px', fontWeight: '600', textAlign: 'right', borderBottom: '1px solid var(--gray-200)', color: i === 2 ? 'var(--gold)' : 'var(--gray-900)' }}>{value}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: '16px', background: 'var(--gold-light)', borderRadius: '8px', padding: '14px', textAlign: 'center' }}>
                      <div style={{ fontSize: '12px', color: 'var(--gray-600)', marginBottom: '4px' }}>Total Profit</div>
                      <div style={{ fontFamily: 'Playfair Display, serif', fontSize: '36px', fontWeight: '700', color: 'var(--gold)' }}>S${fmt(result2.profit)}</div>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', background: 'var(--gray-100)', border: '2px dashed var(--gray-200)', cursor: 'pointer' }} onClick={() => setCompareMode(true)}>
                <div style={{ fontSize: '40px', marginBottom: '12px' }}>⚖️</div>
                <div style={{ fontFamily: 'Playfair Display, serif', fontSize: '18px', marginBottom: '8px' }}>Compare Scenarios</div>
                <div style={{ fontSize: '14px', color: 'var(--gray-600)', marginBottom: '16px' }}>Compare two different amounts, yields, or tenors side by side</div>
                <button className="btn-primary" onClick={() => setCompareMode(true)}>Add Comparison</button>
              </div>
            )}
          </div>

          {/* Comparison summary */}
          {compareMode && result && result2 && (
            <div className="card" style={{ borderTop: '4px solid var(--gray-900)', marginBottom: '24px' }}>
              <h3 style={{ marginBottom: '16px' }}>Side-by-Side Comparison</h3>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th>Primary</th>
                    <th>Compare</th>
                    <th>Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    ['Amount invested', `S$${fmt(result.principal)}`, `S$${fmt(result2.principal)}`, `S$${fmt(result2.principal - result.principal)}`],
                    ['Purchase price', `S$${fmt(result.purchasePrice)}`, `S$${fmt(result2.purchasePrice)}`, ''],
                    ['Profit', `S$${fmt(result.profit)}`, `S$${fmt(result2.profit)}`, `S$${fmt(result2.profit - result.profit)}`],
                    ['Effective yield', `${fmt(result.effectiveYield, 3)}%`, `${fmt(result2.effectiveYield, 3)}%`, `${fmt(result2.effectiveYield - result.effectiveYield, 3)}%`],
                  ].map(([label, v1, v2, diff], i) => (
                    <tr key={i}>
                      <td>{label}</td>
                      <td style={{ color: 'var(--red)', fontWeight: '600' }}>{v1}</td>
                      <td style={{ color: 'var(--gold)', fontWeight: '600' }}>{v2}</td>
                      <td style={{ color: 'var(--gray-600)' }}>{diff}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button onClick={() => setCompareMode(false)} style={{ marginTop: '16px', background: 'none', border: '1px solid var(--gray-200)', borderRadius: '6px', padding: '6px 14px', fontSize: '13px', cursor: 'pointer', color: 'var(--gray-600)' }}>
                Remove Comparison
              </button>
            </div>
          )}

          <div className="disclaimer">
            <strong>How T-Bill pricing works:</strong> T-Bills are sold at a discount to face value. You pay less upfront and receive the full face value at maturity. The difference is your return. The cut-off yield is determined at auction — your actual return may differ from the yield you enter here. Always check the official MAS auction results.
          </div>
        </div>
      </section>

      {/* Donate */}
      <section style={{ paddingBottom: '48px' }} id="donate">
        <div className="container">
          <div className="donate-bar">
            <div>
              <div className="donate-text" style={{ fontWeight: '600', marginBottom: '4px' }}>☕ Enjoying the calculator?</div>
              <div className="donate-text">This tool costs money to run. A small donation helps keep it free for everyone.</div>
            </div>
            <a href="https://ko-fi.com" target="_blank" rel="noopener" className="btn-donate">Buy Me a Coffee</a>
          </div>
        </div>
      </section>
    </>
  );
}

export default function CalculatorPage() {
  return (
    <Suspense fallback={<div style={{ padding: '40px', textAlign: 'center', color: 'var(--gray-400)' }}>Loading...</div>}>
      <CalculatorContent />
    </Suspense>
  );
}
