import { describe, expect, it, mock } from "bun:test";
import {
	type WordCompletionEngine,
	WordCompletionProvider,
	type WordPredictionBackend,
} from "@oh-my-pi/pi-tui/prompt/word-completion";

interface Request {
	before: string;
	prefix: string;
	answer: PromiseWithResolvers<string | null>;
}

interface ManualBackend {
	backend: WordPredictionBackend;
	requests: Request[];
	/** Resolves once the backend has received `count` requests. */
	received(count: number): Promise<void>;
}

/** Backend whose answers the test resolves by hand. */
function manualBackend(): ManualBackend {
	const requests: Request[] = [];
	const waiters: Array<{ count: number; done: () => void }> = [];
	const backend: WordPredictionBackend = {
		complete(before, prefix) {
			const request = { before, prefix, answer: Promise.withResolvers<string | null>() };
			requests.push(request);
			for (const waiter of waiters) if (requests.length >= waiter.count) waiter.done();
			return request.answer.promise;
		},
		feedback: () => {},
	};
	return {
		backend,
		requests,
		received(count) {
			if (requests.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			waiters.push({ count, done: resolve });
			return promise;
		},
	};
}

function provider(backend: WordPredictionBackend): WordCompletionProvider {
	const completion = new WordCompletionProvider(() => backend);
	completion.setMethod("auto");
	return completion;
}

/** Count repaints and await the next one. */
function repaints(completion: WordCompletionProvider): { count(): number; next(): Promise<void> } {
	let count = 0;
	let next = Promise.withResolvers<void>();
	completion.onUpdate = () => {
		count++;
		next.resolve();
		next = Promise.withResolvers<void>();
	};
	return { count: () => count, next: () => next.promise };
}

describe("word completion provider", () => {
	it("asks once per word state, then repaints with the cached answer", async () => {
		const { backend, requests } = manualBackend();
		const completion = provider(backend);
		const repaint = repaints(completion);

		expect(completion.getWordCompletion(["The weath"], 0, 9)).toBeNull();
		expect(completion.getWordCompletion(["The weath"], 0, 9)).toBeNull();
		expect(requests.map(({ before, prefix }) => [before, prefix])).toEqual([["The ", "weath"]]);

		const painted = repaint.next();
		requests[0]?.answer.resolve("er");
		await painted;

		expect(repaint.count()).toBe(1);
		expect(completion.getWordCompletion(["The weath"], 0, 9)).toBe("er");
		expect(requests).toHaveLength(1);
	});

	it("sends earlier lines as context, capped to the last 2000 characters", () => {
		const short = manualBackend();
		provider(short.backend).getWordCompletion(["Fix the parser", "then ref"], 1, 8);
		expect(short.requests.map(({ before, prefix }) => [before, prefix])).toEqual([["Fix the parser\nthen ", "ref"]]);

		const long = manualBackend();
		const earlier = "word ".repeat(600);
		provider(long.backend).getWordCompletion([earlier, "then ref"], 1, 8);
		const before = long.requests[0]?.before ?? "";
		expect(before).toHaveLength(2_000);
		expect(`${earlier}\nthen `.endsWith(before)).toBe(true);
	});

	it("keeps only the newest request queued while the backend is busy", async () => {
		const { backend, requests, received } = manualBackend();
		const completion = provider(backend);
		const repaint = repaints(completion);

		for (const text of ["he", "hel", "hell", "hello"]) completion.getWordCompletion([text], 0, text.length);
		expect(requests.map(request => request.prefix)).toEqual(["he"]);

		requests[0]?.answer.resolve("ro");
		await received(2);
		expect(requests.map(request => request.prefix)).toEqual(["he", "hello"]);
		// The stale "he" answer changes nothing on screen.
		expect(repaint.count()).toBe(0);

		const painted = repaint.next();
		requests[1]?.answer.resolve("ing");
		await painted;
		expect(completion.getWordCompletion(["hello"], 0, 5)).toBe("ing");
	});

	it("keeps a ghost the user types through until the engine offers a different word", async () => {
		const { backend, requests, received } = manualBackend();
		const completion = provider(backend);
		const repaint = repaints(completion);

		completion.getWordCompletion(["can you dep"], 0, 11);
		let painted = repaint.next();
		requests[0]?.answer.resolve("loy");
		await painted;
		expect(completion.getWordCompletion(["can you dep"], 0, 11)).toBe("loy");

		// Typed the next letter of the ghost: its remainder shows before the engine answers,
		// and an engine null (typed-past exclusion) keeps it.
		expect(completion.getWordCompletion(["can you depl"], 0, 12)).toBe("oy");
		requests[1]?.answer.resolve(null);
		completion.getWordCompletion(["can you deplo"], 0, 13);
		await received(3);
		expect(completion.getWordCompletion(["can you depl"], 0, 12)).toBe("oy");
		expect(repaint.count()).toBe(1);

		// A different engine suggestion replaces the ghost.
		expect(completion.getWordCompletion(["can you deplo"], 0, 13)).toBe("y");
		painted = repaint.next();
		requests[2]?.answer.resolve("re");
		await painted;
		expect(completion.getWordCompletion(["can you deplo"], 0, 13)).toBe("re");

		// Diverged from the ghost: nothing to project.
		expect(completion.getWordCompletion(["can you depr"], 0, 12)).toBeNull();
	});

	it("never queries for non-prose words, code, huge buffers, or when off", () => {
		const { backend, requests } = manualBackend();
		const completion = provider(backend);

		expect(completion.getWordCompletion(["/move reciev"], 0, 12)).toBeNull();
		expect(completion.getWordCompletion(["outside", "```text", "reciev", "```"], 2, 6)).toBeNull();
		expect(completion.getWordCompletion(["x".repeat(20_001), "reciev"], 1, 6)).toBeNull();
		expect(completion.getWordCompletion(["see fooBa"], 0, 9)).toBeNull();
		expect(completion.getWordCompletion(["a weath"], 0, 3)).toBeNull();
		completion.setMethod("off");
		expect(completion.getWordCompletion(["The weath"], 0, 9)).toBeNull();
		expect(requests).toEqual([]);
	});

	it("routes queries to the selected engine and drops the previous engine's answers", async () => {
		const engines = new Map<WordCompletionEngine, ManualBackend>([
			["ngram", manualBackend()],
			["apple", manualBackend()],
		]);
		const completion = new WordCompletionProvider(method => engines.get(method)?.backend);
		const repaint = repaints(completion);
		completion.setMethod("ngram");
		completion.getWordCompletion(["The weath"], 0, 9);
		const painted = repaint.next();
		engines.get("ngram")?.requests[0]?.answer.resolve("er");
		await painted;
		expect(completion.getWordCompletion(["The weath"], 0, 9)).toBe("er");

		completion.setMethod("apple");
		expect(completion.getWordCompletion(["The weath"], 0, 9)).toBeNull();
		expect(engines.get("apple")?.requests.map(request => request.prefix)).toEqual(["weath"]);
	});

	it("forwards feedback with the query the suggestion answered", () => {
		const feedback = mock((_before: string, _prefix: string, _suggestion: string, _accepted: boolean) => {});
		const completion = provider({ complete: async () => null, feedback });

		completion.wordCompletionFeedback(["Fix the", "parser in the lex"], 1, 17, "er", true);

		expect(feedback).toHaveBeenCalledWith("Fix the\nparser in the ", "lex", "er", true);
	});
});
