// Hand-written declarations for platform.mjs, so config.ts can import it under `tsc --noEmit`
// without turning allowJs on for the whole tree. Keep in step with platform.mjs.
export type PlatformKey = 'darwin-arm64' | 'win32-x64';

export declare function platformKey(platform?: string, arch?: string): PlatformKey | null;
export declare function unsupportedMessage(platform?: string, arch?: string): string;
export declare const ENGINE_ASSETS: Record<PlatformKey, { archive: string; upstreamBin: string }>;
export declare function engineBinaryName(platform?: string): string;
export declare function installHint(dep: 'git' | 'node' | 'ffmpeg' | 'uv' | 'pipx', platform?: string): string;
export declare function findOnPath(cmd: string, env?: Record<string, string | undefined>, platform?: string): string | null;
export declare function isCmdShim(resolvedPath: string | null | undefined): boolean;
export declare function whisperxSupported(platform?: string, arch?: string): boolean;
export declare function isEngineRunnable(binPath: string, platform?: string): boolean;
