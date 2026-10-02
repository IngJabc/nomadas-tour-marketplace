/**
 * Business timezone configuration.
 *
 * All datetime-local inputs are interpreted as this timezone.
 * All dates are stored as UTC in the database (TIMESTAMPTZ).
 * All display uses this timezone via Intl.DateTimeFormat.
 *
 * Future: per-agency timezone can override this default
 * by reading from agencies.timezone column.
 */
export const BUSINESS_TIMEZONE = 'America/Caracas';

/**
 * Convert a naive datetime-local string (e.g. "2026-07-20T07:00")
 * to a UTC ISO string, interpreting the input as BUSINESS_TIMEZONE.
 *
 * If the input already contains timezone info (+, -, or Z), returns as-is.
 */
export function toUTC(naiveDatetime: string): string {
  const match = naiveDatetime.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (!match) return naiveDatetime;

  const [, y, m, d, h, min, s] = match;
  const year = parseInt(y);
  const month = parseInt(m) - 1;
  const day = parseInt(d);
  const hour = parseInt(h);
  const minute = parseInt(min);
  const second = s ? parseInt(s) : 0;

  const utcAssumed = new Date(Date.UTC(year, month, day, hour, minute, second));

  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(utcAssumed);
  const get = (type: string) => parseInt(parts.find((p) => p.type === type)!.value);

  const tzAsUTC = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  );

  const offsetMs = utcAssumed.getTime() - tzAsUTC;
  const correctUTC = new Date(utcAssumed.getTime() + offsetMs);

  return correctUTC.toISOString();
}

export const DEPARTURE_MUST_BE_FUTURE_MESSAGE =
  'La fecha y hora de salida debe ser posterior a la fecha y hora actual.';

export function isDepartureTimeInFuture(departureTime: string): boolean {
  const departure = new Date(toUTC(departureTime));
  return !Number.isNaN(departure.getTime()) && departure.getTime() > Date.now();
}

/**
 * Format a UTC ISO string in the business timezone.
 * Uses Intl.DateTimeFormat with es-ES locale.
 */
export function formatInTimezone(
  dateString: string,
  overrides?: Intl.DateTimeFormatOptions,
): string {
  const options: Intl.DateTimeFormatOptions = {
    timeZone: BUSINESS_TIMEZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    ...overrides,
  };
  return new Intl.DateTimeFormat('es-ES', options).format(new Date(dateString))
    .replace(/a\.\s*m\./gi, 'AM')
    .replace(/p\.\s*m\./gi, 'PM');
}

/**
 * Format date+time for display (short format).
 * e.g. "20 jul 2026 · 07:00 AM"
 */
export function formatDateTimeShort(dateString: string): string {
  const d = new Date(dateString);
  const date = new Intl.DateTimeFormat('es-ES', {
    timeZone: BUSINESS_TIMEZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(d);
  return `${date} · ${time}`;
}

/**
 * Format only the time portion in 12h format.
 * e.g. "7:00 AM"
 */
export function formatTime12h(dateString: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: BUSINESS_TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(dateString));
}

/**
 * Format only the date portion.
 * e.g. "20 de julio de 2026"
 */
export function formatDateLong(dateString: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: BUSINESS_TIMEZONE,
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(dateString));
}

/**
 * Format date as dd/mm/yyyy.
 * e.g. "20/07/2026"
 */
export function formatDateShort(dateString: string): string {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: BUSINESS_TIMEZONE,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(new Date(dateString));
}

/**
 * Convert a UTC ISO string to a datetime-local format string in BUSINESS_TIMEZONE.
 * e.g. "2026-07-20T11:00:00.000Z" → "2026-07-20T07:00"
 *
 * Used when populating datetime-local inputs from database values.
 */
export function fromUTCToLocal(utcString: string): string {
  const d = new Date(utcString);
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * Extract YYYY-MM-DD from a UTC ISO string in BUSINESS_TIMEZONE.
 * Used for client-side date filtering without UTC drift.
 */
export function toBusinessDateString(dateString: string): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: BUSINESS_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(dateString));
}
