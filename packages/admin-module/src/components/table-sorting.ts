const collator = new Intl.Collator('en-US', {numeric: true, sensitivity: 'base'});
// Compare raw decimals without rounding credit amounts through Number.
export function compareTableValues(a: unknown, b: unknown): number {
  const left = String(a ?? ''), right = String(b ?? '');
  const decimal = /^(-?)(\d+)(?:\.(\d+))?$/;
  const x = left.match(decimal), y = right.match(decimal);
  if (x && y) {
    const scale = Math.max(x[3]?.length ?? 0, y[3]?.length ?? 0);
    const integer = (v: RegExpMatchArray) => BigInt(`${v[1]}${v[2]}${(v[3] ?? '').padEnd(scale, '0')}`);
    const first = integer(x), second = integer(y);
    return first < second ? -1 : first > second ? 1 : 0;
  }
  return collator.compare(left, right);
}
