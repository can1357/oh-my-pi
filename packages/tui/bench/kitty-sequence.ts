import { matchesKittySequence as nativeMatchesKittySequence } from "@oh-my-pi/pi-natives";
import { parseKittySequence } from "../src/keys";

const ITERATIONS = 2000;
const LOCK_MASK = 64 + 128;

const samples = [
	{ name: "ctrl+a", data: "\x1b[97;5u", codepoint: 97, modifier: 4 },
	{ name: "shift+tab", data: "\x1b[9;2u", codepoint: 9, modifier: 1 },
	{ name: "alt+enter", data: "\x1b[13;3u", codepoint: 13, modifier: 2 },
	{ name: "ctrl+right", data: "\x1b[1;5C", codepoint: -3, modifier: 4 },
	{ name: "shift+delete", data: "\x1b[3;2~", codepoint: -10, modifier: 1 },
	{ name: "base-layout", data: "\x1b[108::97;5u", codepoint: 97, modifier: 4 },
];

function matchesKittySequenceJs(data: string, expectedCodepoint: number, expectedModifier: number): boolean {
	const parsed = parseKittySequence(data);
	if (!parsed) return false;
	const actualMod = parsed.modifier & ~LOCK_MASK;
	const expectedMod = expectedModifier & ~LOCK_MASK;
	if (actualMod !== expectedMod) return false;
	if (parsed.codepoint === expectedCodepoint) return true;
	if (parsed.baseLayoutKey !== undefined && parsed.baseLayoutKey === expectedCodepoint) return true;
	return false;
}

function bench(name: string, fn: () => void): number {
	const start = Bun.nanoseconds();
	for (let i = 0; i < ITERATIONS; i++) {
		fn();
	}
	const elapsed = (Bun.nanoseconds() - start) / 1e6;
	const perOp = (elapsed / ITERATIONS).toFixed(6);
	console.log(`${name}: ${elapsed.toFixed(2)}ms total (${perOp}ms/op)`);
	return elapsed;
}

console.log(`Kitty sequence match benchmark (${ITERATIONS} iterations)\n`);

bench("js/parse+match", () => {
	for (const sample of samples) {
		matchesKittySequenceJs(sample.data, sample.codepoint, sample.modifier);
	}
});

bench("native/match", () => {
	for (const sample of samples) {
		nativeMatchesKittySequence(sample.data, sample.codepoint, sample.modifier);
	}
});
