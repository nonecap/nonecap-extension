import { render } from 'preact';
import '../styles/tokens.css';

function Options() {
  return (
    <div style={{ maxWidth: '640px', margin: '0 auto', padding: '32px 24px' }}>
      <h1 style={{ margin: 0, fontSize: '20px', letterSpacing: '-0.02em' }}>NoneCap</h1>
      <p style={{ margin: '8px 0 0', fontSize: '14px', color: 'var(--text-muted)' }}>
        Settings will appear here.
      </p>
    </div>
  );
}

render(<Options />, document.getElementById('root')!);
