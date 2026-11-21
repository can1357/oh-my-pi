import { describe, expect, test } from "bun:test";
import { decodeGitDiffPath } from "@oh-my-pi/pi-coding-agent/utils/git-diff-paths";

describe("decodeGitDiffPath", () => {
	test("preserves whole Unicode characters in C-quoted paths", () => {
		expect(decodeGitDiffPath('"a/emoji 😀 \\"name\\".txt"')).toBe('a/emoji 😀 "name".txt');
		expect(decodeGitDiffPath('"a/\\360\\237\\230\\200.txt"')).toBe("a/😀.txt");
	});
});
