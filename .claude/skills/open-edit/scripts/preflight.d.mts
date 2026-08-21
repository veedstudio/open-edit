// Hand-written declarations for preflight.mjs, so tests can import main() under `tsc --noEmit`.
// Keep in step with preflight.mjs.
export interface ExecResult {
  status: number | null;
  stdout?: string | Buffer | null;
  stderr?: string | Buffer | null;
  error?: Error;
}
export interface PreflightDeps {
  os?: string;
  arch?: string;
  env?: Record<string, string | undefined>;
  exec?: (cmd: string, args: string[], opts?: Record<string, unknown>) => ExecResult;
  fetch?: (url: string, init?: unknown) => Promise<{ ok: boolean; json(): Promise<unknown> }>;
  err?: (line: string) => void;
  out?: (line: string) => void;
  which?: (cmd: string) => string | null | undefined;
}
export declare function defaultDeps(): PreflightDeps;
export declare function main(argv: string[], overrides?: PreflightDeps): Promise<number>;
