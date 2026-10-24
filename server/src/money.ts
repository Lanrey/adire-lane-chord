// Money is stored as integer kobo; tool I/O uses whole naira (spec 04).

export const KOBO = 100;

export const toKobo = (naira: number): number => Math.round(naira * KOBO);
export const toNaira = (kobo: number): number => Math.round(kobo) / KOBO;

export function formatNaira(kobo: number): string {
  return '₦' + toNaira(kobo).toLocaleString('en-NG', { maximumFractionDigits: 2 });
}

/** Round up to the nearest ₦500, in kobo. */
export function roundUpTo500(kobo: number): number {
  const step = 500 * KOBO;
  return Math.ceil(kobo / step) * step;
}
