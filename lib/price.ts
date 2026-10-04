export function formatSeatPrice(cents: number): string {
  const value = cents / 100;
  return `$${value.toLocaleString('es-VE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
