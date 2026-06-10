import { render } from 'preact';
import '../styles/tokens.css';

function Popup() {
  return (
    <div style={{ minWidth: '280px', padding: '16px' }}>
      <h1 style={{ margin: 0, fontSize: '16px', letterSpacing: '-0.01em' }}>NoneCap</h1>
      <p style={{ margin: '6px 0 0', fontSize: '13px', color: 'var(--text-muted)' }}>
        hCaptcha auto solver
      </p>
    </div>
  );
}

render(<Popup />, document.getElementById('root')!);
