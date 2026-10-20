'use client';

import { MessageCircle, Phone } from 'lucide-react';
import type { AgencyPublicContact } from '@/lib/api';
import { contactTelHref, contactWhatsAppHref } from '@/lib/booking/whatsapp';

interface AgencyContactLinksProps {
  /** Solo contactos ya filtrados por el backend (públicos, activos, no eliminados). */
  contacts: AgencyPublicContact[];
  className?: string;
}

/**
 * MKT-008 — Lista de contactos públicos de una agencia: etiqueta + número,
 * con enlace `tel:` para `call` y `wa.me` para `whatsapp`. Los números
 * E.164 se usan tal cual (sin anteponer "58"); si un número no valida,
 * se muestra como texto plano y NUNCA se inventa un enlace.
 */
export function AgencyContactLinks({
  contacts,
  className = '',
}: AgencyContactLinksProps) {
  if (contacts.length === 0) return null;

  return (
    <ul className={`flex flex-col gap-2 ${className}`.trim()}>
      {contacts.map((contact) => {
        const isWhatsApp = contact.channel === 'whatsapp';
        const href = isWhatsApp
          ? contactWhatsAppHref(contact.phone)
          : contactTelHref(contact.phone);
        const icon = isWhatsApp ? (
          <MessageCircle size={16} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Phone size={16} strokeWidth={1.75} aria-hidden="true" />
        );

        return (
          <li key={contact.id}>
            {href ? (
              <a
                href={href}
                {...(isWhatsApp
                  ? { target: '_blank', rel: 'noopener noreferrer' }
                  : {})}
                className="inline-flex items-center gap-2 text-sm text-brand-navy transition-colors duration-200 hover:text-brand-blue"
              >
                {icon}
                <span>
                  <span className="font-normal text-brand-muted">
                    {contact.label}:{' '}
                  </span>
                  <span className="font-semibold">{contact.phone}</span>
                </span>
              </a>
            ) : (
              <span className="inline-flex items-center gap-2 text-sm text-brand-navy">
                {icon}
                <span>
                  <span className="text-brand-muted">
                    {contact.label}:{' '}
                  </span>
                  <span className="font-semibold">{contact.phone}</span>
                </span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
