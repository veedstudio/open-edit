/** Text that did not come from this program, safe to print: control characters (escape sequences among them) become spaces. */
export const printable = (s: unknown): string => String(s ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
