/**
 * Data transformation utilities between Plaid and Actual Budget conventions.
 */

/**
 * Actual Budget requires integer cents and inverts sign:
 * In Plaid: positive amount = debit / outflow, negative amount = credit / inflow.
 * In Actual: negative amount = outflow (expense), positive amount = inflow (income).
 *
 * Formula: round(-plaidAmount * 100)
 */
export function plaidToActualAmount(plaidAmount: number): number {
  if (typeof plaidAmount !== 'number' || isNaN(plaidAmount)) {
    return 0;
  }
  const result = Math.round(-plaidAmount * 100);
  return result === 0 ? 0 : result;
}

/**
 * Payee hygiene:
 * Prioritize clean merchant_name, fallback to raw description name, or default to 'Unknown Payee'.
 */
export function formatPayee(merchantName?: string | null, name?: string | null): string {
  if (merchantName && merchantName.trim()) {
    return merchantName.trim();
  }
  if (name && name.trim()) {
    return name.trim();
  }
  return 'Unknown Payee';
}

/**
 * Clean up account mask/display
 */
export function formatAccountDisplay(name: string, mask?: string | null, officialName?: string | null): string {
  const base = officialName || name;
  if (mask) {
    return `${base} (...${mask})`;
  }
  return base;
}
