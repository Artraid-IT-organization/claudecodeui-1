import { useEffect, useState } from 'react';
import { DEFAULT_PROVIDER } from '../../../utils/defaultProvider';
import { readSelectedProviderRaw } from '../../../utils/selectedProvider';

export function useSelectedProvider() {
  const [provider, setProvider] = useState(() => {
    return readSelectedProviderRaw() || DEFAULT_PROVIDER;
  });

  useEffect(() => {
    // Keep provider in sync when another tab changes the selected provider.
    const handleStorageChange = () => {
      const nextProvider = readSelectedProviderRaw() || DEFAULT_PROVIDER;
      setProvider(nextProvider);
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  return provider;
}
