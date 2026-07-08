declare const process: any;
declare const console: any;
declare class Buffer extends Uint8Array {
	static isBuffer(value: unknown): value is Buffer;
	static from(value: unknown): Buffer;
	static concat(chunks: readonly Buffer[]): Buffer;
	toString(encoding?: string): string;
}

declare module "node:fs/promises" {
	export function access(path: string): Promise<void>;
	export function readFile(path: string, encoding: string): Promise<string>;
	export function appendFile(path: string, data: string, encoding?: string): Promise<void>;
	export function writeFile(path: string, data: string, encoding?: string): Promise<void>;
	export function mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
}

declare module "node:path" {
	export function dirname(path: string): string;
}

declare module "node:crypto" {
	export function randomUUID(): string;
	export function createHash(algorithm: string): {
		update(data: string): { digest(encoding: "hex"): string };
		digest(encoding: "hex"): string;
	};
}
