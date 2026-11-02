// One word of a command printed for someone to paste: bare when a POSIX shell reads it as itself, else
// single-quoted, so a file name with a space or a quote in it survives the paste.
export const shellArg = (a: string): string => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
