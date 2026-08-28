/**
 * `wawoff2` ships no types. Only the one function is used, and only by
 * scripts/gen-fonts.ts — narrow enough to declare here rather than take an
 * `any` and lose the one check that matters (that a Uint8Array goes in).
 */
declare module "wawoff2" {
	export function compress(input: Uint8Array): Promise<Uint8Array>;
	export function decompress(input: Uint8Array): Promise<Uint8Array>;
}
