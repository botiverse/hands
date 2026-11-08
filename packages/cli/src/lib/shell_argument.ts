/** Quote one argument in a suggested command for a POSIX shell. */
export function shellArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(value)
    ? value
    : `'${value.replace(/'/g, "'\\''")}'`;
}
