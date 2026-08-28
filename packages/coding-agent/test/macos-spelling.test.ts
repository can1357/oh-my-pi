import { describe, expect, it, mock } from "bun:test";
import {
	MacOSSpellingProvider,
	type SpellingBackend,
	type SpellingDecorationContext,
} from "../src/modes/macos-spelling";

function backend(overrides: Partial<SpellingBackend>): SpellingBackend {
	return {
		isAvailable: () => true,
		checkSpelling: async () => [],
		completeWord: async () => [],
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
		const provider = new MacOSSpellingProvider(backend({ checkSpelling }));
		provider.setFeatures({ typoDetection: true, autocomplete: false, autocorrect: false });
		const updated = Promise.withResolvers<void>();
		provider.onUpdate = updated.resolve;

		provider.decorateTypos("recieved", decorationContext("recieved"));
		await updated.promise;
		expect(provider.decorateTypos("recieved!", decorationContext("recieved!"))).toContain("\x1b[4:3m");

		secondCheck.resolve([]);
		await Promise.resolve();
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
		provider.setFeatures({ typoDetection: true, autocomplete: false, autocorrect: false });
		const updated = Promise.withResolvers<void>();
		provider.onUpdate = updated.resolve;

		provider.decorateTypos(text, decorationContext(text));
		await updated.promise;
		const rendered = provider.decorateTypos(text, decorationContext(text));
		expect(rendered.replace(/\x1b\[[0-9;:]*m/g, "")).toBe(text);
	});

	it("enables typo detection without enabling autocomplete or autocorrect", async () => {
		const checkSpelling = mock(async () => [{ start: 0, length: 8 }]);
		const completeWord = mock(async () => ["received"]);
		const autocorrectWord = mock(async () => "received");
		const spellingGuesses = mock(async () => ["received", "relieved"]);
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling,
				completeWord,
				autocorrectWord,
				spellingGuesses,
			}),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: false, autocorrect: false });
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
		expect(provider.getWordCompletion(["recieved"], 0, 8)).toBeNull();
		expect(await provider.tryAutocorrect(["recieved "], 0, 9)).toBeNull();
		expect(await provider.getWordReplacements(["recieved "], 0, 9)).toEqual({
			line: 0,
			startCol: 0,
			endCol: 8,
			items: ["received", "relieved"],
		});
		expect(completeWord).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
	});

	it("enables word autocomplete without enabling typo detection or autocorrect", async () => {
		const checkSpelling = mock(async () => [{ start: 4, length: 5 }]);
		const completeWord = mock(async () => ["weather"]);
		const autocorrectWord = mock(async () => "weather");
		const spellingGuesses = mock(async () => ["weather"]);
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling, completeWord, autocorrectWord, spellingGuesses }),
		);
		provider.setFeatures({ typoDetection: false, autocomplete: true, autocorrect: false });
		const updated = Promise.withResolvers<void>();
		const onUpdate = mock(() => updated.resolve());
		provider.onUpdate = onUpdate;

		expect(provider.decorateTypos("The weath", decorationContext("The weath"))).toBe("The weath");
		expect(provider.getWordCompletion(["The weath"], 0, 9)).toBeNull();
		expect(provider.getWordCompletion(["The weath"], 0, 9)).toBeNull();
		expect(completeWord).toHaveBeenCalledTimes(1);
		expect(completeWord).toHaveBeenCalledWith("The weath", 4, 5);
		await updated.promise;
		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(provider.getWordCompletion(["The weath"], 0, 9)).toBe("er");
		expect(completeWord).toHaveBeenCalledTimes(1);
		expect(await provider.tryAutocorrect(["weath "], 0, 6)).toBeNull();
		expect(await provider.getWordReplacements(["The weath"], 0, 6)).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
		expect(spellingGuesses).not.toHaveBeenCalled();
	});

	it("enables autocorrect without enabling typo detection or autocomplete", async () => {
		const checkSpelling = mock(async () => [{ start: 0, length: 10 }]);
		const completeWord = mock(async () => ["definitely"]);
		const spellingGuesses = mock(async () => ["definitely"]);
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling, completeWord, autocorrectWord: async () => "definitely", spellingGuesses }),
		);
		provider.setFeatures({ typoDetection: false, autocomplete: false, autocorrect: true });

		expect(provider.decorateTypos("definately", decorationContext("definately"))).toBe("definately");
		expect(provider.getWordCompletion(["definately"], 0, 10)).toBeNull();
		expect(await provider.tryAutocorrect(["definately "], 0, 11)).toEqual({
			replaceLen: 11,
			insert: "definitely ",
		});
		expect(await provider.getWordReplacements(["definately"], 0, 5)).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(completeWord).not.toHaveBeenCalled();
		expect(spellingGuesses).not.toHaveBeenCalled();
	});

	it("skips paths, slash commands, and inline code", async () => {
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: async text => [
					{ start: text.indexOf("recieved"), length: 8 },
					{ start: text.lastIndexOf("recieved"), length: 8 },
				],
				completeWord: async () => ["received"],
				autocorrectWord: async () => "received",
			}),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: true, autocorrect: true });

		expect(provider.decorateTypos("`recieved` /tmp/recieved", decorationContext("`recieved` /tmp/recieved"))).toBe(
			"`recieved` /tmp/recieved",
		);
		expect(provider.getWordCompletion(["/move reciev"], 0, 12)).toBeNull();
		expect(await provider.tryAutocorrect(["/tmp/recieved "], 0, 14)).toBeNull();
	});
	it("skips fenced code while retaining typo detection in surrounding prose", async () => {
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: async () => [{ start: 0, length: 8 }],
				completeWord: async () => ["received"],
				autocorrectWord: async () => "received",
				spellingGuesses: async () => ["received"],
			}),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: true, autocorrect: true });
		const fencedText = "outside\n```text\nrecieved\n```";
		const fencedLines = fencedText.split("\n");

		expect(provider.decorateTypos("recieved", decorationContext(fencedText, 2))).toBe("recieved");
		expect(provider.getWordCompletion(["outside", "```text", "reciev", "```"], 2, 6)).toBeNull();
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
		const completeWord = mock(async () => ["received"]);
		const autocorrectWord = mock(async () => "received");
		const spellingGuesses = mock(async () => ["received"]);
		const provider = new MacOSSpellingProvider(
			backend({ checkSpelling, completeWord, autocorrectWord, spellingGuesses }),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: true, autocorrect: true });
		const lines = ["x".repeat(20_001), "recieved "];
		const editorText = lines.join("\n");

		expect(provider.decorateTypos("recieved", decorationContext(editorText, 1))).toBe("recieved");
		expect(provider.getWordCompletion(["x".repeat(20_001), "reciev"], 1, 6)).toBeNull();
		expect(await provider.tryAutocorrect(lines, 1, 9)).toBeNull();
		expect(await provider.getWordReplacements(lines, 1, 4)).toBeNull();
		expect(checkSpelling).not.toHaveBeenCalled();
		expect(completeWord).not.toHaveBeenCalled();
		expect(autocorrectWord).not.toHaveBeenCalled();
		expect(spellingGuesses).not.toHaveBeenCalled();
	});
	it("coalesces superseded automatic work while the spelling backend is busy", async () => {
		const typoRequests: Array<{
			text: string;
			result: PromiseWithResolvers<readonly { start: number; length: number }[]>;
		}> = [];
		const completionRequests: Array<{ text: string; result: PromiseWithResolvers<readonly string[]> }> = [];
		const secondTypoStarted = Promise.withResolvers<void>();
		const secondCompletionStarted = Promise.withResolvers<void>();
		const provider = new MacOSSpellingProvider(
			backend({
				checkSpelling: text => {
					const result = Promise.withResolvers<readonly { start: number; length: number }[]>();
					typoRequests.push({ text, result });
					if (typoRequests.length === 2) secondTypoStarted.resolve();
					return result.promise;
				},
				completeWord: text => {
					const result = Promise.withResolvers<readonly string[]>();
					completionRequests.push({ text, result });
					if (completionRequests.length === 2) secondCompletionStarted.resolve();
					return result.promise;
				},
			}),
		);
		provider.setFeatures({ typoDetection: true, autocomplete: true, autocorrect: false });
		const updated = Promise.withResolvers<void>();
		const onUpdate = mock(() => updated.resolve());
		provider.onUpdate = onUpdate;

		for (const text of ["he", "hel", "hell", "hello"]) {
			provider.decorateTypos(text, decorationContext(text));
			provider.getWordCompletion([text], 0, text.length);
		}

		expect(typoRequests.map(request => request.text)).toEqual(["he"]);
		expect(completionRequests.map(request => request.text)).toEqual(["he"]);
		typoRequests[0]?.result.resolve([]);
		completionRequests[0]?.result.resolve(["hero"]);
		await Promise.all([secondTypoStarted.promise, secondCompletionStarted.promise]);
		expect(typoRequests.map(request => request.text)).toEqual(["he", "hello"]);
		expect(completionRequests.map(request => request.text)).toEqual(["he", "hello"]);
		expect(onUpdate).not.toHaveBeenCalled();

		typoRequests[1]?.result.resolve([]);
		completionRequests[1]?.result.resolve(["helloing"]);
		await updated.promise;
		expect(onUpdate).toHaveBeenCalledTimes(1);
	});

	it("disables all spelling work after an asynchronous backend rejection", async () => {
		const failure = Promise.withResolvers<readonly { start: number; length: number }[]>();
		const checkSpelling = mock(() => failure.promise);
		const completeWord = mock(async () => ["received"]);
		const provider = new MacOSSpellingProvider(backend({ checkSpelling, completeWord }));
		provider.setFeatures({ typoDetection: true, autocomplete: true, autocorrect: true });

		expect(provider.decorateTypos("recieved", decorationContext("recieved"))).toBe("recieved");
		expect(checkSpelling).toHaveBeenCalledTimes(1);
		failure.reject(new Error("spell service unavailable"));
		await failure.promise.catch(() => undefined);

		expect(provider.decorateTypos("definately", decorationContext("definately"))).toBe("definately");
		expect(provider.getWordCompletion(["weath"], 0, 5)).toBeNull();
		expect(await provider.tryAutocorrect(["recieved "], 0, 9)).toBeNull();
		expect(await provider.getWordReplacements(["recieved"], 0, 4)).toBeNull();
		expect(checkSpelling).toHaveBeenCalledTimes(1);
		expect(completeWord).not.toHaveBeenCalled();
	});
});
