// ── REP-001 · Resumen de viajes publicados de una agencia ──────────────────
//
// Una sola frase para las dos cifras que publica el perfil y el directorio:
// la estadística SIN filtros (`published_trips_count`) y el total que matchea
// los filtros del usuario (`trips_total`). Siempre en un solo nodo de texto
// para que la cifra y su descripción viajen juntas (jerarquía + accesibilidad).

/**
 * @param total Cantidad de viajes a anunciar.
 * @param filtered `true` cuando la cifra responde a filtros del usuario.
 */
export function tripsSummaryLabel(total: number, filtered: boolean): string {
  if (filtered) {
    return `${total} ${total === 1 ? 'viaje coincide' : 'viajes coinciden'} con tu búsqueda`;
  }
  if (total === 0) return '0 viajes publicados';
  if (total === 1) return '1 viaje publicado disponible';
  return `${total} viajes publicados disponibles`;
}
