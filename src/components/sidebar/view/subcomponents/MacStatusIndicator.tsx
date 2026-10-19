import { useEffect, useState } from 'react';
import { Laptop } from 'lucide-react';

import { cn } from '../../../../lib/utils';
import { Tooltip } from '../../../../shared/view/ui';

type MacStatusData = {
  connected: boolean;
  since?: string;
  method?: string;
  lastCheck?: string;
  searchReady?: boolean;
  exitIp?: string;
  countryCode?: string;
  isVpn?: boolean;
  details?: string;
};

type MacStatusIndicatorProps = {
  variant: 'desktop' | 'mobile';
};

function formatLastCheck(value?: string): string {
  if (!value) {
    return '—';
  }
  try {
    return new Date(value).toLocaleString('ru-RU', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return value;
  }
}

export default function MacStatusIndicator({ variant }: MacStatusIndicatorProps) {
  const [data, setData] = useState<MacStatusData | null>(null);
  const [linkLost, setLinkLost] = useState(false);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let aborted = false;

    fetch('/api/mac-status')
      .then((response) => response.json())
      .then((payload: unknown) => {
        if (aborted) return;
        if (payload && typeof payload === 'object' && 'connected' in payload) {
          setData(payload as MacStatusData);
        }
      })
      .catch(() => {
        // The SSE stream will drive subsequent updates once it connects.
      });

    if (typeof EventSource !== 'undefined') {
      eventSource = new EventSource('/api/mac-status/stream');

      eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data) as MacStatusData;
          setData(payload);
          setLinkLost(false);
        } catch {
          // Ignore malformed messages.
        }
      };

      eventSource.onopen = () => {
        setLinkLost(false);
      };

      eventSource.onerror = () => {
        if (eventSource && eventSource.readyState !== EventSource.OPEN) {
          setLinkLost(true);
        }
      };
    }

    return () => {
      aborted = true;
      if (eventSource) {
        eventSource.close();
      }
    };
  }, []);

  const status = linkLost || !data?.connected
    ? 'disconnected'
    : data.searchReady
      ? 'ready'
      : 'vpn';

  const dotClass = {
    ready: 'bg-green-500',
    vpn: 'bg-yellow-400',
    disconnected: 'bg-red-500',
  }[status];

  const tooltip = linkLost
    ? 'Статус MacBook недоступен: связь с сервером потеряна'
    : status === 'ready'
      ? `MacBook подключён, российский выход готов (${data?.exitIp || 'IP проверен'})`
      : status === 'vpn'
        ? `MacBook подключён, но поиск заблокирован: ${data?.isVpn ? 'обнаружен VPN' : data?.details || 'выход не подтверждён'} (${data?.exitIp || 'IP неизвестен'})`
        : `MacBook не подключён, последняя проверка ${formatLastCheck(data?.lastCheck)}`;

  const isDesktop = variant === 'desktop';
  const wrapperSize = isDesktop ? 'h-7 w-7' : 'h-8 w-8';
  const iconSize = isDesktop ? 'h-3.5 w-3.5' : 'h-4 w-4';

  return (
    <Tooltip
      content={tooltip}
      position="bottom"
      className="max-w-64 whitespace-normal text-center"
    >
      <div
        aria-label={tooltip}
        className={cn(
          'relative flex items-center justify-center rounded-lg text-muted-foreground',
          wrapperSize,
        )}
      >
        <div className="relative">
          <Laptop className={iconSize} />
          <span
            className={cn(
              'absolute bottom-0 right-0 h-1.5 w-1.5 rounded-full ring-1 ring-background',
              dotClass,
            )}
          />
        </div>
      </div>
    </Tooltip>
  );
}
