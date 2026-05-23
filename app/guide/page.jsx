'use client';

import Link from 'next/link';

const METHODS = [
  {
    icon: '🏦',
    title: 'Internet Banking',
    badge: 'Most Popular',
    badgeType: 'badge-red',
    banks: ['DBS/POSB', 'OCBC', 'UOB', 'Standard Chartered', 'HSBC', 'Citibank'],
    steps: [
      'Log in to your bank internet banking portal',
      'Navigate to Investments or Securities',
      'Select Singapore Government Securities or T-Bills',
      'Enter amount (min S$1,000, multiples of S$1,000)',
      'Submit before the closing date',
    ],
    note: 'No additional fees. Funds debited on issue date.',
  },
  {
    icon: '🏧',
    title: 'ATM (DBS/POSB)',
    badge: 'Walk-in Option',
    badgeType: 'badge-gold',
    banks: ['DBS ATM', 'POSB ATM'],
    steps: [
      'Visit any DBS or POSB ATM',
      'Select More Services',
      'Choose Securities then T-Bills',
      'Enter your investment amount',
      'Confirm and collect your receipt',
    ],
    note: 'Available at DBS/POSB ATMs only. No online account needed.',
  },
  {
    icon: '📊',
    title: 'CPF Ordinary Account (OA)',
    badge: 'Tax Efficient',
    badgeType: 'badge-green',
    banks: ['DBS/POSB', 'OCBC', 'UOB'],
    steps: [
      'Log in to your bank internet banking',
      'Select CPF Investment Scheme (CPFIS)',
      'Choose T-Bills under fixed income',
      'Enter amount from your CPF OA',
      'Submit before the closing date',
    ],
    note: 'Uses CPF OA funds. Returns credited back to CPF OA at maturity. Subject to CPF investment rules.',
  },
  {
    icon: '🎯',
    title: 'Supplementary Retirement Scheme (SRS)',
    badge: 'Tax Savings',
    badgeType: 'badge-green',
    banks: ['DBS/POSB', 'OCBC', 'UOB'],
    steps: [
      'Log in to your SRS bank internet banking',
      'Navigate to SRS Investments',
      'Select T-Bills from investment options',
      'Enter amount from your SRS account',
      'Submit before the closing date',
    ],
    note: 'Uses SRS funds. Reduces taxable income. Good for higher-income earners.',
  },
];

const FAQ = [
  {
    q: 'What is the minimum investment amount?',
    a: 'S$1,000, in multiples of S$1,000. There is no maximum for retail investors.',
  },
  {
    q: 'When will I receive my money back?',
    a: 'At maturity — 6 months for a 6-month T-Bill, 1 year for a 1-year T-Bill. The full face value is credited to your bank account on the maturity date.',
  },
  {
    q: 'Can I sell my T-Bill before maturity?',
    a: 'Yes. T-Bills can be sold on the secondary market through your broker. However, the price depends on market conditions and you may receive more or less than face value.',
  },
  {
    q: 'Is the yield guaranteed?',
    a: 'No. The cut-off yield is determined at auction. As a non-competitive bidder, you accept whatever yield is set. You are guaranteed allocation but not the yield.',
  },
  {
    q: 'Are T-Bill returns taxable in Singapore?',
    a: 'Interest income from Singapore Government Securities including T-Bills is tax-exempt for individuals in Singapore.',
  },
  {
    q: 'What happens if I miss the application deadline?',
    a: 'You will need to wait for the next auction. T-Bill auctions are held regularly — typically bi-weekly for 6-month T-Bills.',
  },
  {
    q: 'Can foreigners buy Singapore T-Bills?',
    a: 'Yes, foreigners can apply through Singapore banks where they hold accounts. However, CPF and SRS methods are only available to eligible Singapore Citizens, PRs, and certain pass holders.',
  },
  {
    q: 'What is the difference between T-Bills and Singapore Savings Bonds (SSB)?',
    a: 'T-Bills are short-term (up to 1 year), sold at a discount, and yield is fixed at auction. SSBs are long-term (up to 10 years), pay monthly interest, and can be redeemed any month without penalty.',
  },
];

export default function GuidePage() {
  return (
    <>
      <div className="page-header">
        <div className="page-header-inner">
          <h1>How to Buy T-Bills</h1>
          <p>A plain-English guide to applying for Singapore Treasury Bills — no financial jargon.</p>
        </div>
      </div>

      <section className="section">
        <div className="container">

          {/* Quick overview */}
          <div className="card" style={{ borderTop: '4px solid var(--red)', marginBottom: '48px' }}>
            <h2 style={{ fontSize: '22px', marginBottom: '16px' }}>Before You Apply</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '20px' }}>
              {[
                { icon: '✅', title: 'You Need', items: ['Singapore bank account (DBS, OCBC, UOB, etc.)', 'At least S$1,000 in cash, CPF OA, or SRS', 'Apply before the closing date'] },
                { icon: '📅', title: 'Key Dates', items: ['Application closes Thursday before auction', 'Auction results announced next day', 'Issue date approx 1 week after auction'] },
                { icon: '💡', title: 'Good to Know', items: ['Non-competitive bids are always allocated', 'No brokerage fees for primary market', 'Returns are tax-exempt for individuals'] },
              ].map((col, i) => (
                <div key={i}>
                  <div style={{ fontSize: '20px', marginBottom: '8px' }}>{col.icon}</div>
                  <div style={{ fontWeight: '700', fontSize: '14px', marginBottom: '10px', color: 'var(--gray-900)' }}>{col.title}</div>
                  <ul style={{ listStyle: 'none', padding: 0 }}>
                    {col.items.map((item, j) => (
                      <li key={j} style={{ fontSize: '13px', color: 'var(--gray-600)', padding: '4px 0', paddingLeft: '12px', borderLeft: '2px solid var(--red-light)', marginBottom: '6px', lineHeight: '1.5' }}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>

          {/* Application methods */}
          <div className="section-label">Application Methods</div>
          <h2 className="section-title" style={{ fontSize: '28px', marginBottom: '8px' }}>4 Ways to Apply</h2>
          <p className="section-sub" style={{ marginBottom: '32px' }}>Choose the method that works best for your situation.</p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px', marginBottom: '48px' }}>
            {METHODS.map((method, i) => (
              <div key={i} className="card">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px', flexWrap: 'wrap', gap: '12px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
                    <div style={{ fontSize: '32px' }}>{method.icon}</div>
                    <div>
                      <h3 style={{ fontSize: '19px', marginBottom: '4px' }}>{method.title}</h3>
                      <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                        <span className={`badge ${method.badgeType}`}>{method.badge}</span>
                        {method.banks.slice(0, 3).map((b, j) => (
                          <span key={j} className="badge" style={{ background: 'var(--gray-100)', color: 'var(--gray-600)' }}>{b}</span>
                        ))}
                        {method.banks.length > 3 && (
                          <span className="badge" style={{ background: 'var(--gray-100)', color: 'var(--gray-600)' }}>+{method.banks.length - 3} more</span>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: '700', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--gray-400)', marginBottom: '12px' }}>Steps</div>
                    <ol style={{ paddingLeft: '18px', fontSize: '14px', color: 'var(--gray-600)', lineHeight: '1.8' }}>
                      {method.steps.map((step, j) => (
                        <li key={j} style={{ marginBottom: '4px' }}>{step}</li>
                      ))}
                    </ol>
                  </div>
                  <div>
                    <div style={{ fontSize: '11px', fontWeight: '700', letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--gray-400)', marginBottom: '12px' }}>Note</div>
                    <div style={{ background: 'var(--gray-100)', borderRadius: '8px', padding: '14px', fontSize: '13px', color: 'var(--gray-600)', lineHeight: '1.6' }}>
                      {method.note}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* FAQ */}
          <div className="section-label">FAQ</div>
          <h2 className="section-title" style={{ fontSize: '28px', marginBottom: '32px' }}>Common Questions</h2>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '48px' }}>
            {FAQ.map((item, i) => (
              <details key={i} style={{ background: 'white', border: '1px solid var(--gray-200)', borderRadius: '10px', padding: '16px 20px', cursor: 'pointer' }}>
                <summary style={{ fontWeight: '600', fontSize: '15px', color: 'var(--gray-900)', listStyle: 'none', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                  {item.q}
                  <span style={{ color: 'var(--red)', flexShrink: 0, fontSize: '18px' }}>+</span>
                </summary>
                <div style={{ marginTop: '12px', fontSize: '14px', color: 'var(--gray-600)', lineHeight: '1.7', borderTop: '1px solid var(--gray-200)', paddingTop: '12px' }}>
                  {item.a}
                </div>
              </details>
            ))}
          </div>

          {/* CTA */}
          <div style={{ textAlign: 'center', padding: '48px', background: 'var(--red)', borderRadius: '16px', color: 'white', marginBottom: '32px' }}>
            <h2 style={{ fontSize: '28px', marginBottom: '12px', color: 'white' }}>Ready to Calculate Your Returns?</h2>
            <p style={{ opacity: 0.85, marginBottom: '24px', fontSize: '15px' }}>Use our calculator to see exactly how much you will earn before applying.</p>
            <Link href="/calculator" className="btn-primary">Open Calculator →</Link>
          </div>

          <div id="donate">
            <div className="donate-bar">
              <div>
                <div className="donate-text" style={{ fontWeight: '600', marginBottom: '4px' }}>☕ Was this guide helpful?</div>
                <div className="donate-text">A small donation helps keep SG T-Bill Buddy free and maintained.</div>
              </div>
              <a href="https://ko-fi.com" target="_blank" rel="noopener" className="btn-donate">Buy Me a Coffee</a>
            </div>
          </div>

          <div style={{ marginTop: '24px' }}>
            <div className="disclaimer">
              This guide is for informational purposes only and does not constitute financial advice. Application procedures may change — always refer to your bank and MAS for the latest instructions. SG T-Bill Buddy is not affiliated with MAS, any Singapore bank, or the Singapore Government.
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
