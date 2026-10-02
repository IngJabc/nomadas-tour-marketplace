'use client';

import { AuthProvider } from '@/components/auth/AuthProvider';
import type { ReactNode } from 'react';

export function RootProviders({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
