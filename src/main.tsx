import { createRoot } from 'react-dom/client';
import 'katex/dist/katex.min.css';
import App from './App';

function mountFatalOverlay(title: string, message: string): void {
  let el = document.getElementById('fatal-error-overlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'fatal-error-overlay';
    el.style.position = 'fixed';
    el.style.inset = '0';
    el.style.zIndex = '99999';
    el.style.background = 'rgba(8,10,14,0.96)';
    el.style.color = '#f3f6fb';
    el.style.fontFamily = 'ui-monospace, SFMono-Regular, Menlo, monospace';
    el.style.padding = '16px';
    el.style.whiteSpace = 'pre-wrap';
    el.style.overflow = 'auto';
    document.body.appendChild(el);
  }
  el.textContent = `${title}\n\n${message}`;
}

window.addEventListener('error', (event) => {
  if (!event.error) return;
  mountFatalOverlay('Runtime Error', event.error.stack ?? String(event.error));
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  mountFatalOverlay('Unhandled Promise Rejection', message);
});

createRoot(document.getElementById('root')!).render(
  <App />,
);
