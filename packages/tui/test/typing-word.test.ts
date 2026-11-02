import { describe, expect, it } from "bun:test";
import { TypingWordTracker } from "@oh-my-pi/pi-tui/prompt/typing-word";

describe("TypingWordTracker", () => {
	it("holds the word under the caret until a separator is typed", () => {
		const tracker = new TypingWordTracker();
		tracker.update(0, [""], 0, 0, true);
		expect(tracker.word).toBeUndefined();

		expect(tracker.update(1, ["helo"], 0, 4, true)).toBe(true);
		expect(tracker.word).toEqual({ line: 0, start: 0, end: 4 });

		expect(tracker.update(2, ["helo "], 0, 5, true)).toBe(true);
		expect(tracker.word).toBeUndefined();

		tracker.update(3, ["helo,"], 0, 5, true);
		expect(tracker.word).toBeUndefined();
	});

	it("keeps the word while the caret stays in it and drops it once the caret leaves", () => {
		const tracker = new TypingWordTracker();
		tracker.update(0, ["wrld "], 0, 5, true);
		tracker.update(1, ["wrld helo"], 0, 9, true);
		expect(tracker.word).toEqual({ line: 0, start: 5, end: 9 });

		expect(tracker.update(1, ["wrld helo"], 0, 6, true)).toBe(false);
		expect(tracker.word).toEqual({ line: 0, start: 5, end: 9 });

		expect(tracker.update(1, ["wrld helo"], 0, 2, true)).toBe(true);
		expect(tracker.word).toBeUndefined();

		// Coming back without typing leaves its mark shown.
		tracker.update(1, ["wrld helo"], 0, 9, true);
		expect(tracker.word).toBeUndefined();
	});

	it("drops the word on another line or on blur", () => {
		const tracker = new TypingWordTracker();
		tracker.update(0, ["", "x"], 0, 0, true);
		tracker.update(1, ["helo", "x"], 0, 4, true);
		expect(tracker.update(1, ["helo", "x"], 1, 0, true)).toBe(true);
		expect(tracker.word).toBeUndefined();

		tracker.update(2, ["helo", "x"], 0, 4, true);
		expect(tracker.word).toEqual({ line: 0, start: 0, end: 4 });
		expect(tracker.update(2, ["helo", "x"], 0, 4, false)).toBe(true);
		expect(tracker.word).toBeUndefined();
	});

	it("does not hold a word the first time it sees the text", () => {
		const tracker = new TypingWordTracker();
		tracker.update(7, ["restored helo"], 0, 13, true);
		expect(tracker.word).toBeUndefined();
	});

	it("joins contractions and keeps accented letters in the word", () => {
		const tracker = new TypingWordTracker();
		tracker.update(0, [""], 0, 0, true);
		tracker.update(1, ["say don't"], 0, 9, true);
		expect(tracker.word).toEqual({ line: 0, start: 4, end: 9 });
		tracker.update(2, ["café"], 0, 4, true);
		expect(tracker.word).toEqual({ line: 0, start: 0, end: 4 });
	});
});
