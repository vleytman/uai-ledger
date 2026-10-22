/** Exact UI conversions. Monetary values never pass through Number. */
export function unitsToUsd(value: unknown): string {
  const input = String(value ?? '0');
  if (!/^-?\d+$/.test(input)) return input;
  const negative = input.startsWith('-');
  const digits = (negative ? input.slice(1) : input).padStart(10, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -9)}.${digits.slice(-9)}`.replace(
    /\.?0+$/,
    '',
  );
}
export function usdToUnits(value: string): string {
  const text = value.trim();
  if (!/^(?:\d+(?:\.\d{0,9})?|\.\d{1,9})$/.test(text))
    throw new Error(
      'Enter a nonnegative USD amount with up to 9 decimal places.',
    );
  const [whole, fraction = ''] = text.split('.');
  return (
    BigInt(whole || '0') * 1000000000n +
    BigInt(fraction.padEnd(9, '0'))
  ).toString();
}
export function durationLabel(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}
export function listRows(value: any): any[] {
  return Array.isArray(value) ? value : (value?.data ?? value?.items ?? []);
}
export function updateProperty(
  value: Record<string, any>,
  key: string,
  next: any,
) {
  const updated = { ...value };
  if (next === undefined) delete updated[key];
  else
    Object.defineProperty(updated, key, {
      value: next,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  return updated;
}
export function thresholdUnit(signal: string): string {
  if (
    [
      'provider.budget_low',
      'platform.exposure_high',
      'reconciliation.discrepancy',
    ].includes(signal)
  )
    return 'budget units; 1 USD = 1,000,000,000 units';
  if (
    [
      'queue.delay_high',
      'provider.balance_stale',
      'pricing.missing_or_stale',
    ].includes(signal)
  )
    return 'seconds';
  if (signal === 'provider.degraded') return 'percent of failed attempts';
  if (signal === 'limiter.unknown_slots_held') return 'slots';
  return 'optional event condition';
}

export function durationToUnits(value: string, multiplier: number): number {
  if (!/^\d+(\.\d+)?$/.test(value))
    throw new Error('Enter a nonnegative duration.');
  const [whole, fraction = ''] = value.split('.');
  const divisor = 10n ** BigInt(fraction.length);
  const numerator = BigInt(whole + fraction) * BigInt(multiplier);
  if (
    numerator % divisor !== 0n ||
    numerator / divisor > BigInt(Number.MAX_SAFE_INTEGER)
  )
    throw new Error(
      'The duration must resolve to a whole number of base units.',
    );
  return Number(numerator / divisor);
}

export function unitsToCredits(value:unknown):string {const raw=String(value??'0');if(!/^\d+$/.test(raw))return raw;const v=raw.padStart(7,'0');return `${v.slice(0,-6)}.${v.slice(-6)}`.replace(/\.?0+$/,'');}
export function creditsToUnits(value:string):string {if(!/^(?:\d+(?:\.\d{0,6})?|\.\d{1,6})$/.test(value.trim()))throw new Error('Enter credits with up to 6 decimal places.');const [whole,fraction='']=value.trim().split('.');return (BigInt(whole||'0')*1000000n+BigInt(fraction.padEnd(6,'0'))).toString();}
