// Minimal ambient types for the bun runtime — keeps the zero-dependency
// strict typecheck honest without @types/node.
declare const console: { log: (...args: any[]) => void };
declare const process: { env: Record<string, string | undefined>; exit: (code?: number) => never };
declare function setTimeout(callback: (...args: any[]) => void, ms: number): unknown;
declare class AbortSignal {
	readonly aborted: boolean;
}

// Node builtins used by the OpenCode identity helper (opencode-nested.ts).
declare module "node:crypto" {
	export function createHash(algorithm: string): { update(data: string): { digest(): Uint8Array } };
	export function randomBytes(size: number): Uint8Array;
}
declare module "node:fs" {
	export function readFileSync(path: string, encoding: "utf8"): string;
}
declare module "node:os" {
	export function homedir(): string;
}
declare module "node:path" {
	export function join(...parts: string[]): string;
}
