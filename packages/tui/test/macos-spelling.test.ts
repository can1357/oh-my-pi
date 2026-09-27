import { describe, expect, it, mock } from "bun:test";
import { MacOSSpellingProvider, type SpellingBackend } from "@oh-my-pi/pi-tui/prompt/macos-spelling";
import type { SpellingDecorationContext } from "@oh-my-pi/pi-tui/prompt/prose-gate";
import { setMagicKeywords } from "@oh-my-pi/pi-tui/prompt/magic-keywords";

function backend(overrides: Partial<SpellingBackend>): SpellingBackend {
	return {
		isAvailable: () => true,
		checkSpelling: async () => [],
		autocorrectWord: async () => null,
		spellingGuesses: async () => [],
		...overrides,
	};
}

function decorationContext(editorText: string, line: number = 0, startCol: number = 0): SpellingDecorationContext {
	return { editorText, lines: editorText.split("\n"), line, startCol };
}

describe("macOS spelling feature gates", () => {
	it("keeps typo undercurls visible while a changed line is rechecked", async () => {
		const secondCheck = Promise.withResolvers<readonly { start: number; length: number }[]>();
		const checkSpelling = mock((text: string) =>
			text === "recieved" ? Promise.resolve([{ start: 0, length: 8 }]) : secondCheck.promise,
		);
		const provider = new MacOSSpellingProvider(backend({ checkSpelling }), true);
		provider.setFeatures({ typoDetection: true, autocorrect: false });
		const updated = Promise.withResolvers<void>();
		provider.onUpdate = updated.resolve;

		provider.decorateTypos("recieved", decorationContext("recieved"));
		await updated.promise;
		expect(provider.decorateTypos("recieved!", decorationContext("recieved!"))).toContain("\x1b[4:3m");

		secondCheck.resolve([]);
		await Promise.resolve();
	});
	it("keeps the queued verification check when a projected undercurl paints while busy", async () => {
		// Regression: fast-typing "each" projected the stale "eac" range from the
		// cached "{ #eac" check onto "{ #each" and then deleted its own queued
		// verification check, freezing the undercurl until an unrelated repaint.
		const requests: Array<{
			text: string;
			result: PromiseWithResolvers<readonly { start: number; length: number }[]>;
		}> = [];
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: text => {
					const result = Promise.withResolvers<readonly { start: number; length: number }[]>();
					requests.push({ text, result });
					return result.promise;
				},
			}),
			true,
		);
		provider.setFeatures({ typoDetection: true, autocorrect: false });
		let updated = Promise.withResolvers<void>();
		provider.onUpdate = () => updated.resolve();

		provider.decorateTypos("{ #eac", decorationContext("{ #eac"));
		requests[0]?.result.resolve([{ start: 3, length: 3 }]);
		await updated.promise;
		updated = Promise.withResolvers();

		// A check for another lane is in flight when the extended text renders.
		const editorText = "{ #each\nother";
		provider.decorateTypos("other", decorationContext(editorText, 1));
		const painted = provider.decorateTypos("{ #each", decorationContext(editorText, 0));
		expect(painted).toContain("\x1b[4:3m"); // transitional projected undercurl on "eac"
		await Bun.sleep(0); // let the queued "other" check start
		expect(requests.map(request => request.text)).toEqual(["{ #eac", "other"]);

		requests[1]?.result.resolve([]);
		await Bun.sleep(0);
		// The queued verification for "{ #each" must survive the projected paint.
		expect(requests.map(request => request.text)).toEqual(["{ #eac", "other", "{ #each"]);

		requests[2]?.result.resolve([]);
		await updated.promise;
		expect(provider.decorateTypos("{ #each", decorationContext(editorText, 0))).toBe("{ #each");
	});
	it("never re-emits text when the backend returns overlapping typo ranges", async () => {
		// Regression: a whole-line range overlapping a word range made decorateTypos
		// render the overlapped slice twice ("thgh" → "thghthgh") and desynced the
		// rendered width from the measured width, teleporting the cursor.
		const text = "stencil-labs inc thgh";
		const checkSpelling = mock(async () => [
			{ start: 0, length: text.length },
			{ start: 17, length: 4 },
		]);
		const provider = new MacOSSpellingProvider(backend({ checkSpelling }));
		provider.setFeatures({ typoDetection: true, autocorrect: false });
		const updated = Promise.withResolvers<void>();
		provider.onUpdate = updated.resolve;

		provider.decorateTypos(text, decorationContext(text));
		await updated.promise;
		const rendered = provider.decorateTypos(text, decorationContext(text));
		expect(rendered.replace(/\x1b\[[0-9;:]*m/g, "")).toBe(text);
	});

	it("enables typo detection without enabling autocorrect", async () => {
		const checkSpelling = mock(async () => [{ start: 0, length: 8 }]);
		const autocorrectWord = mock(async () => "received");
		const spellingGuesses = mock(async () => ["received", "relieved"]);
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling,
				autocorrectWord,
				spellingGuesses,
			}),
			true,
		);
		provider.setFeatures({ typoDetection: true, autocorrect: false });
		const updated = Promise.withResolvers<void>();
		const onUpdate = mock(() => updated.resolve());
		provider.onUpdate = onUpdate;

		expect(provider.decorateTypos("recieved", decorationContext("recieved"))).toBe("recieved");
		expect(provider.decorateTypos("recieved", decorationContext("recieved"))).toBe("recieved");
		expect(checkSpelling).toHaveBeenCalledTimes(1);
		await updated.promise;
		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(provider.decorateTypos("recieved", decorationContext("recieved"))).toBe(
			"\x1b[4:3m\x1b[58:2::255:95:95mrecieved\x1b[4:0m\x1b[59m",
		);
		expect(await provider.tryAutocorrect(["recieved "], 0, 9)).toBeNull();
		expect(await provider.getWordReplacements(["recieved "], 0, 9)).toEqual({
			line: 0,
			startCol: 0,
			endCol: 8,
			items: ["received", "relieved"],
		});
		expect(autocorrectWord).not.toHaveBeenCalled();
	});

	it("enables autocorrect without enabling typo detection", async () => {
		const checkSpelling = mock(async () => [{ start: 0, length: 10 }]);
		const spellingGuesses = mock(async () => ["definitely"]);
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling, autocorrectWord: async () => "definitely", spellingGuesses }),
		);
		provider.setFeatures({ typoDetection: false, autocorrect: true });

		expect(provider.decorateTypos("definately", decorationContext("definately"))).toBe("definately");
		expect(await provider.tryAutocorrect(["definately "], 0, 11)).toEqual({
			replaceLen: 11,
			insert: "definitely ",
		});
		expect(await provider.getWordReplacements(["definately"], 0, 5)).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(spellingGuesses).not.toHaveBeenCalled();
	});

	it("never autocorrects or underlines a registered magic keyword", async () => {
		setMagicKeywords([{ word: "workflowz", hue: [30, 150] }]);
		try {
			const autocorrectWord = mock(async () => "workflows");
			const provider = new MacOSSpellingProvider(
				backend({
					// macOS flags both words; only the non-keyword survives.
					checkSpelling: async text => [
						{ start: text.indexOf("workflowz"), length: 9 },
						{ start: text.indexOf("recieved"), length: 8 },
					],
					autocorrectWord,
				}),
				true,
			);
			provider.setFeatures({ typoDetection: true, autocorrect: true });

			expect(await provider.tryAutocorrect(["please workflowz "], 0, 17)).toBeNull();
			expect(autocorrectWord).not.toHaveBeenCalled();

			const updated = Promise.withResolvers<void>();
			provider.onUpdate = updated.resolve;
			const text = "workflowz recieved";
			provider.decorateTypos(text, decorationContext(text));
			await updated.promise;
			expect(provider.decorateTypos(text, decorationContext(text))).toBe(
				"workflowz \x1b[4:3m\x1b[58:2::255:95:95mrecieved\x1b[4:0m\x1b[59m",
			);
		} finally {
			setMagicKeywords([]);
		}
	});

	it("skips paths, slash commands, and inline code", async () => {
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: async text => [
					{ start: text.indexOf("recieved"), length: 8 },
					{ start: text.lastIndexOf("recieved"), length: 8 },
				],
				autocorrectWord: async () => "received",
			}),
		);
		provider.setFeatures({ typoDetection: true, autocorrect: true });

		expect(provider.decorateTypos("`recieved` /tmp/recieved", decorationContext("`recieved` /tmp/recieved"))).toBe(
			"`recieved` /tmp/recieved",
		);
		expect(await provider.tryAutocorrect(["/tmp/recieved "], 0, 14)).toBeNull();
	});
	it("skips fenced code while retaining typo detection in surrounding prose", async () => {
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: async () => [{ start: 0, length: 8 }],
				autocorrectWord: async () => "received",
				spellingGuesses: async () => ["received"],
			}),
			true,
		);
		provider.setFeatures({ typoDetection: true, autocorrect: true });
		const fencedText = "outside\n```text\nrecieved\n```";
		const fencedLines = fencedText.split("\n");

		expect(provider.decorateTypos("recieved", decorationContext(fencedText, 2))).toBe("recieved");
		expect(await provider.tryAutocorrect(["```text", "recieved ", "```"], 1, 9)).toBeNull();
		expect(await provider.getWordReplacements(fencedLines, 2, 4)).toBeNull();

		const updated = Promise.withResolvers<void>();
		provider.onUpdate = updated.resolve;
		expect(provider.decorateTypos("recieved", decorationContext("recieved"))).toBe("recieved");
		await updated.promise;
		expect(provider.decorateTypos("recieved", decorationContext("recieved"))).toContain("\x1b[4:3m");
	});

	it("does no spelling work for huge editor buffers", async () => {
		const checkSpelling = mock(async () => [{ start: 0, length: 8 }]);
		const autocorrectWord = mock(async () => "received");
		const spellingGuesses = mock(async () => ["received"]);
		const provider = new MacOSSpellingProvider(backend({ checkSpelling, autocorrectWord, spellingGuesses }));
		provider.setFeatures({ typoDetection: true, autocorrect: true });
		const lines = ["x".repeat(20_001), "recieved "];
		const editorText = lines.join("\n");

		expect(provider.decorateTypos("recieved", decorationContext(editorText, 1))).toBe("recieved");
		expect(await provider.tryAutocorrect(lines, 1, 9)).toBeNull();
		expect(await provider.getWordReplacements(lines, 1, 4)).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
		expect(spellingGuesses).not.toHaveBeenCalled();
	});
	it("coalesces superseded automatic typo checks while the spelling backend is busy", async () => {
		const typoRequests: Array<{
			text: string;
			result: PromiseWithResolvers<readonly { start: number; length: number }[]>;
		}> = [];
		const secondTypoStarted = Promise.withResolvers<void>();
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: text => {
					const result = Promise.withResolvers<readonly { start: number; length: number }[]>();
					typoRequests.push({ text, result });
					if (typoRequests.length === 2) secondTypoStarted.resolve();
					return result.promise;
				},
			}),
		);
		provider.setFeatures({ typoDetection: true, autocorrect: false });

		for (const text of ["he", "hel", "hell", "hello"]) {
			provider.decorateTypos(text, decorationContext(text));
		}

		expect(typoRequests.map(request => request.text)).toEqual(["he"]);
		typoRequests[0]?.result.resolve([]);
		await secondTypoStarted.promise;
		expect(typoRequests.map(request => request.text)).toEqual(["he", "hello"]);
	});

	it("disables all spelling work after an asynchronous backend rejection", async () => {
		const failure = Promise.withResolvers<readonly { start: number; length: number }[]>();
		const checkSpelling = mock(() => failure.promise);
		const provider = new MacOSSpellingProvider(backend({ checkSpelling }));
		provider.setFeatures({ typoDetection: true, autocorrect: true });

		expect(provider.decorateTypos("recieved", decorationContext("recieved"))).toBe("recieved");
		expect(checkSpelling).toHaveBeenCalledTimes(1);
		failure.reject(new Error("spell service unavailable"));
		await failure.promise.catch(() => undefined);

		expect(provider.decorateTypos("definately", decorationContext("definately"))).toBe("definately");
		expect(await provider.tryAutocorrect(["recieved "], 0, 9)).toBeNull();
		expect(await provider.getWordReplacements(["recieved"], 0, 4)).toBeNull();
		expect(checkSpelling).toHaveBeenCalledTimes(1);
	});
});

describe("typo underline capability selection", () => {
	async function renderFlaggedWord(styledUnderlines: boolean): Promise<string> {
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling: async () => [{ start: 0, length: 3 }] }),
			styledUnderlines,
		);
		provider.setFeatures({ typoDetection: true, autocorrect: false });
		const updated = Promise.withResolvers<void>();
		provider.onUpdate = updated.resolve;
		provider.decorateTypos("teh", decorationContext("teh"));
		await updated.promise;
		return provider.decorateTypos("teh", decorationContext("teh"));
	}

	it("emits a flat CSI 4 m / CSI 24 m underline with no colon SGR when styled underlines are unsupported", async () => {
		const rendered = await renderFlaggedWord(false);
		expect(rendered).toContain("\x1b[4m");
		expect(rendered).toContain("\x1b[24m");
		for (const forbidden of ["4:3", "4:0", "58:", "59"]) {
			expect(rendered).not.toContain(forbidden);
		}
	});

	it("emits the red curly colon-form underline when styled underlines are supported", async () => {
		const rendered = await renderFlaggedWord(true);
		expect(rendered).toContain("\x1b[4:3m");
		expect(rendered).toContain("\x1b[58:2::255:95:95m");
		expect(rendered).toContain("\x1b[4:0m");
		expect(rendered).toContain("\x1b[59m");
	});
});
