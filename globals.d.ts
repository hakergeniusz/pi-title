// Minimal ambient types for the bun runtime — keeps the zero-dependency
// strict typecheck honest without @types/node.
declare const console: { log: (...args: any[]) => void };
declare const process: { env: Record<string, string | undefined>; exit: (code?: number) => never };
declare function setTimeout(callback: (...args: any[]) => void, ms: number): unknown;
