import { parseKey as nativeParseKey } from "@oh-my-pi/pi-natives";
import * as native from "../src/keys";
import { makeBench } from "./_harness";
import * as js from "./_jskey";

const ITERATIONS = 2000;

// Test cases covering various input types
const samples = [
	// Kitty protocol sequences
	{ name: "kitty ctrl+a", data: "\x1b[97;5u", expected: "ctrl+a" },
	{ name: "kitty shift+tab", data: "\x1b[9;2u", expected: "shift+tab" },
	{ name: "kitty alt+enter", data: "\x1b[13;3u", expected: "alt+enter" },
	{ name: "kitty ctrl+right", data: "\x1b[1;5C", expected: "ctrl+right" },
	{ name: "kitty shift+delete", data: "\x1b[3;2~", expected: "shift+delete" },
	{ name: "kitty base-layout", data: "\x1b[108::97;5u", expected: "ctrl+a" },

	// Legacy sequences
	{ name: "legacy escape", data: "\x1b", expected: "escape" },
	{ name: "legacy tab", data: "\t", expected: "tab" },
	{ name: "legacy enter", data: "\r", expected: "enter" },
	{ name: "legacy space", data: " ", expected: "space" },
	{ name: "legacy backspace", data: "\x7f", expected: "backspace" },
	{ name: "legacy shift+tab", data: "\x1b[Z", expected: "shift+tab" },
	{ name: "legacy up", data: "\x1b[A", expected: "up" },
	{ name: "legacy down", data: "\x1b[B", expected: "down" },
	{ name: "legacy left", data: "\x1b[D", expected: "left" },
	{ name: "legacy right", data: "\x1b[C", expected: "right" },
	{ name: "legacy home", data: "\x1b[H", expected: "home" },
	{ name: "legacy end", data: "\x1b[F", expected: "end" },
	{ name: "legacy delete", data: "\x1b[3~", expected: "delete" },
	{ name: "legacy pageUp", data: "\x1b[5~", expected: "pageUp" },
	{ name: "legacy pageDown", data: "\x1b[6~", expected: "pageDown" },

	// Function keys
	{ name: "legacy f1", data: "\x1bOP", expected: "f1" },
	{ name: "legacy f5", data: "\x1b[15~", expected: "f5" },
	{ name: "legacy f12", data: "\x1b[24~", expected: "f12" },

	// Ctrl sequences
	{ name: "ctrl+c", data: "\x03", expected: "ctrl+c" },
	{ name: "ctrl+z", data: "\x1a", expected: "ctrl+z" },
	{ name: "ctrl+space", data: "\x00", expected: "ctrl+space" },

	// Alt sequences (legacy mode)
	{ name: "alt+backspace", data: "\x1b\x7f", expected: "alt+backspace" },
	{ name: "alt+left", data: "\x1bb", expected: "alt+left" },
	{ name: "alt+right", data: "\x1bf", expected: "alt+right" },

	// Arrow with modifiers (legacy)
	{ name: "shift+up", data: "\x1b[a", expected: "shift+up" },
	{ name: "ctrl+up", data: "\x1bOa", expected: "ctrl+up" },

	// Printable characters
	{ name: "letter a", data: "a", expected: "a" },
	{ name: "letter z", data: "z", expected: "z" },
	{ name: "symbol /", data: "/", expected: "/" },
];

const bench = makeBench(ITERATIONS);

// Set to legacy mode for consistent comparison
js.setKittyProtocolActive(true);
native.setKittyProtocolActive(true);

console.log(`parseKey benchmark (${ITERATIONS} iterations, ${samples.length} samples each)\n`);

// Verify correctness first
let mismatches = 0;
for (const sample of samples) {
	const jsResult = js.parseKey(sample.data);
	const nativeResult = nativeParseKey(sample.data, false);
	if (jsResult !== nativeResult) {
		console.log(`MISMATCH ${sample.name}: js="${jsResult}" native="${nativeResult}" expected="${sample.expected}"`);
		mismatches++;
	}
}
if (mismatches > 0) {
	console.log(`\n${mismatches} mismatches found!\n`);
} else {
	console.log("All results match.\n");
}

const jsTime = bench("js/parseKey", () => {
	for (const sample of samples) {
		js.parseKey(sample.data);
	}
});

const nativeTime = bench("native/parseKey", () => {
	for (const sample of samples) {
		native.parseKey(sample.data);
	}
});

console.log(`\nSpeedup: ${(jsTime / nativeTime).toFixed(2)}x`);

bench("js/parse+match", () => {
	for (const sample of samples) {
		js.matchesKey(sample.data, sample.expected as any);
	}
});

bench("native/match", () => {
	for (const sample of samples) {
		native.matchesKey(sample.data, sample.expected as any);
	}
});
