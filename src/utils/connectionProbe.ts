import { authenticatedFetch } from './api';

type NetworkInformation = {
  effectiveType?: string;
  type?: string;
};

let probesLeft = 40;

export function reportConnectionProbe(entry: Record<string, string | number | boolean>) {
  if (probesLeft <= 0) return;
  probesLeft -= 1;
  const connection = (navigator as Navigator & { connection?: NetworkInformation }).connection;
  const body = JSON.stringify({
    ...entry,
    online: navigator.onLine,
    visibility: document.visibilityState,
    network: connection?.type ?? 'unknown',
    effectiveType: connection?.effectiveType ?? 'unknown',
  });
  console.info('[connection-probe]', body);
  void authenticatedFetch('/api/user/catchup-probe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: true,
  }).catch(() => undefined);
}
