'use client';

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import type {
  SupportMessageCategory,
  SupportMessageIdentifiers,
} from '@/lib/support/whatsapp-support';

/**
 * SUP-003 — Contexto mensajero del botón flotante de soporte.
 *
 * `SupportMessageProvider` vive en `RootProviders` y envuelve toda la app.
 * Cada pantalla declara su contexto con `useSupportMessage({ category,
 * identifiers })` y el botón flotante global arma el mensaje de WhatsApp
 * con esa categoría y, si los hay, los identificadores (boleto, reserva,
 * compra). Al desmontar la pantalla el contexto vuelve a `null` y el
 * botón cae en la categoría derivada de la ruta.
 *
 * El hook es un no-op si no hay provider (pantallas montadas sueltas en
 * tests): nunca lanza.
 */
export interface SupportMessageValue {
  category: SupportMessageCategory;
  identifiers?: SupportMessageIdentifiers | null;
}

interface SupportMessageState {
  category: SupportMessageCategory | null;
  identifiers: SupportMessageIdentifiers | null;
}

const ValueContext = createContext<SupportMessageState | null>(null);

const SetContext = createContext<
  ((value: SupportMessageState | null) => void) | null
>(null);

export function SupportMessageProvider({ children }: { children: ReactNode }) {
  const [value, setValue] = useState<SupportMessageState | null>(null);

  return (
    <ValueContext.Provider value={value}>
      <SetContext.Provider value={setValue}>{children}</SetContext.Provider>
    </ValueContext.Provider>
  );
}

/** Estado actual del contexto (lo consume `WhatsAppSupportButton`). */
export function useSupportMessageContext(): SupportMessageState | null {
  return useContext(ValueContext);
}

/**
 * Declara el contexto de soporte de la pantalla actual (SUP-003).
 *
 * Uso:
 *   useSupportMessage({ category: 'payment', identifiers: { purchaseId } });
 *
 * Las dependencias del efecto son primitivas (categoría + identificadores)
 * para que un objeto inline en la pantalla no genere bucles de render.
 */
export function useSupportMessage(value: SupportMessageValue | null): void {
  const set = useContext(SetContext);
  const category = value?.category ?? null;
  const ticketCode = value?.identifiers?.ticketCode ?? null;
  const reservationId = value?.identifiers?.reservationId ?? null;
  const purchaseId = value?.identifiers?.purchaseId ?? null;

  useEffect(() => {
    if (!set || category === null) return;

    const hasIdentifiers = Boolean(ticketCode || reservationId || purchaseId);
    set({
      category,
      identifiers: hasIdentifiers
        ? { ticketCode, reservationId, purchaseId }
        : null,
    });
    return () => set(null);
  }, [set, category, ticketCode, reservationId, purchaseId]);
}
