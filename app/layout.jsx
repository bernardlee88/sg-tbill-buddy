import './globals.css';

export const metadata = {
  title: 'SG T-Bill Buddy — Singapore Treasury Bill Calculator & Guide',
  description: 'Calculate your T-Bill returns, check upcoming auction dates, and learn how to invest in Singapore Treasury Bills. Free, simple, and built for Singapore retail investors.',
  keywords: 'Singapore T-Bill, treasury bill calculator, MAS auction, T-bill yield, Singapore investment',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="true" />
      </head>
      <body>
        <nav className="nav">
          <div className="nav-inner">
            <a href="/" className="nav-logo">
              <div className="nav-logo-icon">T$</div>
              <span className="nav-logo-text">SG T-Bill <span>Buddy</span></span>
            </a>
            <ul className="nav-links">
              <li><a href="/calculator">Calculator</a></li>
              <li><a href="/auctions">Auctions</a></li>
              <li><a href="/guide">How to Buy</a></li>
              <li><a href="#donate" className="nav-donate">☕ Support</a></li>
            </ul>
          </div>
        </nav>
        {children}
        <footer className="footer">
          <div className="footer-inner">
            <div className="footer-brand">SG T-Bill <span>Buddy</span></div>
            <ul className="footer-links">
              <li><a href="/calculator">Calculator</a></li>
              <li><a href="/auctions">Auctions</a></li>
              <li><a href="/guide">How to Buy</a></li>
              <li><a href="https://www.mas.gov.sg" target="_blank" rel="noopener">MAS Website</a></li>
            </ul>
          </div>
          <div className="footer-note">
            Data sourced from the Monetary Authority of Singapore (MAS). This tool is for informational purposes only and does not constitute financial advice. Not affiliated with MAS or the Singapore Government.
          </div>
        </footer>
      </body>
    </html>
  );
}
