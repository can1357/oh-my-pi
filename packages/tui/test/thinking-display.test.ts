import { describe, expect, it } from "bun:test";
import {
	canonicalizeMessage,
	formatThinkingForDisplay,
	resetThinkingDisplayCacheForTests,
} from "@oh-my-pi/pi-tui/chat/thinking-display";

describe("canonicalizeMessage", () => {
	it("returns empty string for undefined, empty, or whitespace-only", () => {
		expect(canonicalizeMessage(undefined)).toBe("");
		expect(canonicalizeMessage("")).toBe("");
		expect(canonicalizeMessage("   ")).toBe("");
		expect(canonicalizeMessage("\n\n")).toBe("");
	});

	it("returns empty string for dot-only content", () => {
		expect(canonicalizeMessage(".")).toBe("");
		expect(canonicalizeMessage("...")).toBe("");
		expect(canonicalizeMessage(" . ")).toBe("");
		expect(canonicalizeMessage("\n.")).toBe("");
		expect(canonicalizeMessage("…")).toBe("");
	});

	it("returns normal canonical content for actual prose", () => {
		expect(canonicalizeMessage("hello")).toBe("hello");
		expect(canonicalizeMessage("hello.")).toBe("hello.");
		expect(canonicalizeMessage(". hello .")).toBe(". hello .");
		expect(canonicalizeMessage("a")).toBe("a");
	});
});

// Streaming fixtures: prose with comment noise, fenced code, open fences,
// tilde/backtick variants, trailing newlines, and degenerate shapes.
const STREAM_FIXTURES = [
	"hello",
	"**Headline**\n\nSome reasoning with `inline` code.\n\nAnother thought.",
	"line one\nline two\n\n\n",
	"```js\nconst x = 1;\nconsole.log(x);\n```\nafter fence",
	"```\nnever closed\nstill open",
	"intro\n```js\ncode\n```\ntail with trailing.\n",
	"Step 1.\n\n<!-- -->\nStep 2.\n",
	"Step.\n\n<!--\nmore",
	"a\nb\nc\n",
	"start ```\n```\nend",
	"```\n```",
	"~~~\ntilde fence\n~~~\n",
	"```\n\n```",
	"`x\n```y\nz",
];

describe("formatThinkingForDisplay incremental streaming", () => {
	// Resetting the memo forces the next call to take the full-recompute
	// path, giving a cold-cache reference value.
	for (const proseOnly of [false, true]) {
		for (const [idx, fixture] of STREAM_FIXTURES.entries()) {
			it(`byte-identical to full recompute at every split point (mode=${proseOnly ? "prose" : "raw"}, fixture ${idx})`, () => {
				const n = fixture.length;
				// Reference: cold-start full recompute for every prefix.
				const expected: string[] = [];
				for (let i = 0; i <= n; i++) {
					resetThinkingDisplayCacheForTests();
					expected[i] = formatThinkingForDisplay(fixture.slice(0, i), proseOnly);
				}
				// For every split point, feed the incremental stream up to it
				// and compare every intermediate and final output.
				for (let i = 1; i <= n; i++) {
					resetThinkingDisplayCacheForTests();
					for (let j = 1; j <= i; j++) {
						expect(formatThinkingForDisplay(fixture.slice(0, j), proseOnly)).toBe(expected[j]!);
					}
				}
			});
		}
	}
});

describe("formatThinkingForDisplay append streaming", () => {
	// ~10 bytes/tick mixing prose, newlines, fences, and a comment marker so
	// both modes exercise the fold path rather than a shortcut.
	const CHUNKS = [
		"step ",
		"through the ",
		"plan:\n",
		"```js\n",
		"value += 1;\n",
		"```\n",
		"next idea\n",
		"with detail ",
		"and more.\n",
		"<!-- note\n",
	];
	const TICKS = 5000;
	const texts: string[] = [];
	{
		// Monotonically growing stream; joined per tick so fixtures are flat
		// strings rather than lazy `+=`-accumulated ropes.
		const parts: string[] = [];
		for (let i = 0; i < TICKS; i++) {
			parts.push(CHUNKS[i % CHUNKS.length]!);
			texts.push(parts.join(""));
		}
	}

	it(`streamed output stays byte-identical to a cold recompute (${TICKS} ticks, raw + prose)`, () => {
		for (const proseOnly of [false, true]) {
			let lastOut = "";
			for (let t = 0; t < TICKS; t++) {
				lastOut = formatThinkingForDisplay(texts[t]!, proseOnly);
			}
			// The streamed result must match one cold recompute of the full
			// text; the reset retires every memo slot first so the final
			// comparison cannot answer from cache.
			resetThinkingDisplayCacheForTests();
			expect(lastOut).toBe(formatThinkingForDisplay(texts[TICKS - 1]!, proseOnly));
		}
	});

	it("exact repeats keep returning the identical display", () => {
		for (const proseOnly of [false, true]) {
			const final = texts[TICKS - 1]!;
			const out = formatThinkingForDisplay(final, proseOnly);
			let stable = true;
			for (let i = 0; i < 2000; i++) {
				if (formatThinkingForDisplay(final, proseOnly) !== out) stable = false;
			}
			expect(stable).toBe(true);
		}
	});
});

describe("formatThinkingForDisplay interleaved blocks", () => {
	// One message streams several thinking blocks, and every tick formats each
	// of them in turn. Streams share leading text (one stream's early state is
	// a prefix of another's), one is comment-free (raw identity shortcut), and
	// there are more streams than memo slots, so hits, appends, retired-slot
	// reuse and LRU eviction all interleave.
	const STREAMS = [
		["Plan:\n", "check the ", "fence\n", "```ts\n", "let x = 1;\n", "```\n", "done.\n", "<!-- -->\n"],
		["Plan:", "\n", "other ", "branch\n", "<!--", " -->\n", "~~~\n", "tilde\n"],
		["plain ", "comment-free ", "raw text\n", "```\n", "code\n", "```\n", "more\n", "end"],
		["<!--\n", "note\n", "**Head**\n", "\n", "<!-- -->\n", "body ", "text.\n", "tail"],
		["x", "y", "z\n", "```\n", "a\n", "b\n", "```\n", "."],
	];

	for (const proseOnly of [false, true]) {
		it(`every interleaved step matches a cold recompute (mode=${proseOnly ? "prose" : "raw"})`, () => {
			const prefixes = STREAMS.map(chunks => chunks.map((_, i) => chunks.slice(0, i + 1).join("")));
			const cold = prefixes.map(texts =>
				texts.map(text => {
					resetThinkingDisplayCacheForTests();
					return formatThinkingForDisplay(text, proseOnly);
				}),
			);
			resetThinkingDisplayCacheForTests();
			for (let tick = 0; tick < 8; tick++) {
				for (let s = 0; s < STREAMS.length; s++) {
					// Twice per tick, like the reveal count + slice + render passes.
					expect(formatThinkingForDisplay(prefixes[s]![tick]!, proseOnly)).toBe(cold[s]![tick]!);
					expect(formatThinkingForDisplay(prefixes[s]![tick]!, proseOnly)).toBe(cold[s]![tick]!);
				}
			}
		});
	}
});
describe("formatThinkingForDisplay adversarial append detection", () => {
	// The retired spot-check detector anchored on {first byte, midpoint,
	// trailing 32-byte window}, leaving positions 1..seam-33 unchecked whenever
	// seam >= 34. Seed geometry: first newline at index 41, so seam = 42 and
	// the unchecked gap was [1, 9]. A mutation at ANY position in [1, seam)
	// must produce exactly the cold-recompute output — never a stale
	// committed prefix resumed from the unmutated seed.
	const GAP_SEED_PROSE = `I${"B".repeat(40)}\n\`\`\`\ncode\nX`;
	const GAP_SEED_RAW = `I${"B".repeat(40)}\n<!-- -->\nplain tail`;
	const SEAM = 42;

	for (const proseOnly of [false, true]) {
		const seed = proseOnly ? GAP_SEED_PROSE : GAP_SEED_RAW;
		it(`mutation anywhere in [1, seam) matches cold recompute (mode=${proseOnly ? "prose" : "raw"}, incl. retired gap [1, ${SEAM - 33}])`, () => {
			for (let p = 1; p < SEAM; p++) {
				const mutant = `${seed.slice(0, p)}${seed.charAt(p) === "Z" ? "Q" : "Z"}${seed.slice(p + 1)} more`;
				resetThinkingDisplayCacheForTests();
				const cold = formatThinkingForDisplay(mutant, proseOnly);
				resetThinkingDisplayCacheForTests();
				formatThinkingForDisplay(seed, proseOnly);
				expect(formatThinkingForDisplay(mutant, proseOnly)).toBe(cold);
			}
		});
	}
});

describe("formatThinkingForDisplay raw identity shortcut slot hygiene", () => {
	it("shortcut records the slot but never leaves a resumable checkpoint", () => {
		// Open fence behind an earlier newline, no comment yet: the raw
		// identity shortcut fires and records the slot.
		const base = "intro\n```\ncode line";
		// The marker then arrives inside the still-open fence: raw mode keeps
		// fence contents, but a resume from a bogus checkpoint claiming
		// "not in fence" would drop it. The cleared checkpoint forces a
		// recompute that matches the cold reference.
		const grown = `${base}\n<!-- -->`;
		resetThinkingDisplayCacheForTests();
		const coldGrown = formatThinkingForDisplay(grown, false);
		expect(coldGrown).toContain("<!-- -->");
		resetThinkingDisplayCacheForTests();
		formatThinkingForDisplay(base, false);
		expect(formatThinkingForDisplay(grown, false)).toBe(coldGrown);

		// An exact repeat of a shortcut text is served by the recorded memo.
		resetThinkingDisplayCacheForTests();
		const once = formatThinkingForDisplay(base, false);
		expect(formatThinkingForDisplay(base, false)).toBe(once);
	});
});

describe("formatThinkingForDisplay seam-transition battery", () => {
	// Long no-newline prefix crossing the 8KiB resume cap, then a fence
	// transition, then multi-line appends continuing past a final newline;
	// the comment marker appears only in the tail, so raw mode hands off from
	// the identity shortcut to a folding state mid-stream. EVERY split point
	// must match the cold recompute.
	for (const proseOnly of [false, true]) {
		it(`byte-identical at every split point across cap/fence/marker transitions (mode=${proseOnly ? "prose" : "raw"})`, () => {
			const fixture = `${"x".repeat(8300)}\n\`\`\`js\nstep one\nstep two\n\`\`\`\ntail prose.\n<!-- -->\nappended`;
			const n = fixture.length;
			// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
			const refs: string[] = new Array(n + 1);
			for (let i = 0; i <= n; i++) {
				resetThinkingDisplayCacheForTests();
				refs[i] = formatThinkingForDisplay(fixture.slice(0, i), proseOnly);
			}
			resetThinkingDisplayCacheForTests();
			for (let i = 1; i <= n; i++) {
				expect(formatThinkingForDisplay(fixture.slice(0, i), proseOnly)).toBe(refs[i]);
			}
		});
	}
});

describe("formatThinkingForDisplay no-newline scaling", () => {
	// Chunks deliberately never contain a newline: the seam stays at byte 0,
	// the shape that refolded the whole text every tick before the resume
	// cap. Streams here cross MAX_RESUME_PARTIAL_BYTES (8192) mid-run; later
	// ticks degrade to the identity memo / full recompute — the pre-PR
	// asymptotics for this pathological shape, bounded per call. The
	// bounded-cost property itself is benchmarked (see PR), not asserted here.
	const NL_FREE_CHUNKS = ["word ", "token ", "and ", "more "];
	const buildTexts = (ticks: number, chunk?: string) => {
		const parts: string[] = [];
		const texts: string[] = [];
		for (let i = 0; i < ticks; i++) {
			parts.push(chunk ?? NL_FREE_CHUNKS[i % NL_FREE_CHUNKS.length]!);
			texts.push(parts.join(""));
		}
		return texts;
	};

	it("prose growth through the resume cap stays byte-identical to a cold recompute", () => {
		const specs: Array<{ ticks: number; chunk?: string }> = [
			{ ticks: 2400 }, // ~12 KB of ~5-byte chunks: crosses the 8 KiB cap mid-run
			{ ticks: 1200, chunk: "z".repeat(16) }, // ~19 KB of uniform oversized chunks
		];
		for (const spec of specs) {
			const texts = buildTexts(spec.ticks, spec.chunk);
			let lastOut = "";
			for (const text of texts) lastOut = formatThinkingForDisplay(text, true);
			// Byte-identical through the cap transition; the reset retires
			// every memo slot so the comparison recomputes from scratch.
			resetThinkingDisplayCacheForTests();
			expect(lastOut).toBe(formatThinkingForDisplay(texts[texts.length - 1]!, true));
		}
	});

	it("repeats on the post-cap text answer from the memo with the same display", () => {
		const texts = buildTexts(2400);
		const final = texts[texts.length - 1]!;
		let out = "";
		for (const text of texts) out = formatThinkingForDisplay(text, true);
		resetThinkingDisplayCacheForTests();
		expect(out).toBe(formatThinkingForDisplay(final, true));
	});
});

describe("formatThinkingForDisplay adversarial differential fuzz", () => {
	// Deterministic xorshift32 — no flaky randomness. Generators target the
	// two retired blind spots: mutations diverging inside the previously
	// unchecked seam-gap region, and no-newline chains long enough to cross
	// the resume cap. Every step judges the LIVE slot against a freshly
	// reset cold reference.
	const FRAGMENTS = [
		"word ",
		"plan:\n",
		"```js\n",
		"code;\n",
		"```\n",
		"<!-- -->\n",
		"<!--\n",
		" -->\n",
		"tail.\n",
		"~~~\n",
		"`tick` ",
		"> quote\n",
		"\n",
	];
	const NL_FREE = ["word ", "token ", "and ", "-->", "<!--", "```", " . ", "Z"];

	it("gap-divergent mutations, no-newline chains, shrinks and stream switches all match cold recompute (>4000 checks)", () => {
		let s = 0x9e3779b9 | 0;
		const rnd = () => {
			s ^= s << 13;
			s ^= s >>> 17;
			s ^= s << 5;
			s |= 0;
			return (s >>> 0) / 4294967296;
		};
		const pick = (arr: string[]) => arr[Math.floor(rnd() * arr.length)]!;

		let checks = 0;
		const failures: string[] = [];
		for (let trial = 0; trial < 220; trial++) {
			for (const proseOnly of [false, true]) {
				const noNewline = trial % 3 === 0;
				let text = "";
				for (let step = 0; step < 14; step++) {
					const prev = text;
					const roll = rnd();
					if (prev.length === 0 || roll < 0.55) {
						const frag =
							noNewline && rnd() < 0.5
								? "z".repeat(600 + Math.floor(rnd() * 900))
								: pick(noNewline ? NL_FREE : FRAGMENTS);
						text = prev + frag;
					} else if (roll < 0.85 && prev.length > 2) {
						// Mutate one byte, biased into [1, seam-33] — the region
						// the retired spot-check anchors left unchecked.
						const seam = prev.lastIndexOf("\n") + 1;
						const limit = Math.max(1, Math.min(seam, prev.length) - 33);
						const p = 1 + Math.floor(rnd() * limit);
						if (p >= prev.length) text = prev + pick(FRAGMENTS);
						else text = `${prev.slice(0, p)}${prev.charAt(p) === "Z" ? "Q" : "Z"}${prev.slice(p + 1)}`;
					} else if (roll < 0.93 && prev.length > 4) {
						text = prev.slice(0, 1 + Math.floor(rnd() * (prev.length - 1)));
					} else {
						text = pick(["", "```", "<!--"]);
					}
					if (!text) continue;

					const actual = formatThinkingForDisplay(text, proseOnly);
					resetThinkingDisplayCacheForTests();
					const expected = formatThinkingForDisplay(text, proseOnly);
					checks++;
					if (actual !== expected && failures.length < 5) {
						failures.push(`trial=${trial} mode=${proseOnly ? "prose" : "raw"} step=${step} len=${text.length}`);
					}
				}
			}
		}
		expect(failures).toEqual([]);
		expect(checks).toBeGreaterThan(4000);
	});
});
