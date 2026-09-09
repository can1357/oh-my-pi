import { describe, expect, it } from "bun:test";
import { KeybindingsManager as AppKeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { getGithubRefContext, getGithubRefSuggestions } from "@oh-my-pi/pi-coding-agent/modes/github-ref-autocomplete";
import { createPromptActionAutocompleteProvider } from "@oh-my-pi/pi-coding-agent/modes/prompt-action-autocomplete";
import type { SlashCommand } from "@oh-my-pi/pi-tui";

function makeProvider(commands: SlashCommand[] = []) {
	return createPromptActionAutocompleteProvider({
		commands,
		basePath: "/tmp",
		keybindings: AppKeybindingsManager.inMemory({}),
		copyCurrentLine: () => {},
		copyPrompt: () => {},
		undo: () => {},
		moveCursorToMessageEnd: () => {},
		moveCursorToMessageStart: () => {},
		moveCursorToLineStart: () => {},
		moveCursorToLineEnd: () => {},
	});
}

describe("github-ref autocomplete — token detection", () => {
	it("matches a standalone #<number> ending at the cursor", () => {
		expect(getGithubRefContext("#3164")).toEqual({ prefix: "#3164", qualifier: null, number: "3164" });
		expect(getGithubRefContext("look at #3164")).toEqual({ prefix: "#3164", qualifier: null, number: "3164" });
		// only the token ending at the cursor (the $ anchor) wins
		expect(getGithubRefContext("see #1 then #3164")).toEqual({
			prefix: "#3164",
			qualifier: null,
			number: "3164",
		});
	});

	it("requires a token boundary before # so embedded hashes don't match", () => {
		// cross-repo reference, mid-word, URL fragment — none should offer candidates
		expect(getGithubRefContext("owner/repo#3164")).toBeNull();
		expect(getGithubRefContext("foo#3164")).toBeNull();
		expect(getGithubRefContext("C#12")).toBeNull();
		expect(getGithubRefContext("https://github.com/can1357/oh-my-pi#3164")).toBeNull();
		expect(getGithubRefContext("path/#3164")).toBeNull();
	});

	it("does not match bare #, text, mixed, zero, or leading zeros", () => {
		expect(getGithubRefContext("#")).toBeNull();
		expect(getGithubRefContext("#copy")).toBeNull();
		expect(getGithubRefContext("#3164abc")).toBeNull();
		expect(getGithubRefContext("#3a")).toBeNull();
		// a space after the digits closes the token
		expect(getGithubRefContext("#3164 ")).toBeNull();
		expect(getGithubRefContext("#0")).toBeNull();
		expect(getGithubRefContext("#0123")).toBeNull();
	});

	it("detects a pr/pull/issue qualifier word immediately before the number", () => {
		expect(getGithubRefContext("pr #3164")).toEqual({ prefix: "pr #3164", qualifier: "pr", number: "3164" });
		expect(getGithubRefContext("PR #3164")).toEqual({ prefix: "PR #3164", qualifier: "pr", number: "3164" });
		expect(getGithubRefContext("pull #3164")).toEqual({ prefix: "pull #3164", qualifier: "pr", number: "3164" });
		expect(getGithubRefContext("issue #3164")).toEqual({
			prefix: "issue #3164",
			qualifier: "issue",
			number: "3164",
		});
		// the word right before the number is the qualifier, even with leading text
		expect(getGithubRefContext("look at the issue #3164")?.qualifier).toBe("issue");
	});

	it("does not treat arbitrary words, or qualifiers glued to a path, as the type", () => {
		expect(getGithubRefContext("review #3164")?.qualifier).toBeNull();
		// "pr" inside "src/pr" is preceded by '/', not a boundary, so it is not a qualifier
		expect(getGithubRefContext("src/pr #3164")?.qualifier).toBeNull();
		// a qualifier with no space before the # is not recognized
		expect(getGithubRefContext("pr#3164")).toBeNull();
	});
});

describe("github-ref autocomplete — suggestions", () => {
	it("offers both candidates when no qualifier is given", () => {
		const result = getGithubRefSuggestions("#3164");
		expect(result).not.toBeNull();
		expect(result!.prefix).toBe("#3164");
		expect(result!.items).toEqual([
			{ value: "pr://3164", label: "PR #3164", description: "GitHub pull request" },
			{ value: "issue://3164", label: "Issue #3164", description: "GitHub issue" },
		]);
	});

	it("offers only the PR candidate for a pr/pull qualifier", () => {
		const result = getGithubRefSuggestions("pr #3164");
		expect(result!.prefix).toBe("pr #3164");
		expect(result!.items).toEqual([{ value: "pr://3164", label: "PR #3164", description: "GitHub pull request" }]);
	});

	it("offers only the Issue candidate for an issue qualifier", () => {
		const result = getGithubRefSuggestions("issue #3164");
		expect(result!.items).toEqual([{ value: "issue://3164", label: "Issue #3164", description: "GitHub issue" }]);
	});

	it("returns null for embedded or non-ref text", () => {
		expect(getGithubRefSuggestions("owner/repo#3164")).toBeNull();
		expect(getGithubRefSuggestions("#copy")).toBeNull();
		expect(getGithubRefSuggestions("#0")).toBeNull();
	});
});

describe("github-ref autocomplete — provider integration", () => {
	it("yields both candidates and rewrites the token to the chosen internal URL", async () => {
		const provider = makeProvider();
		const suggestions = await provider.getSuggestions(["review #3164"], 0, 12);
		expect(suggestions).not.toBeNull();
		expect(suggestions!.prefix).toBe("#3164");
		expect(suggestions!.items.map(item => item.value)).toEqual(["pr://3164", "issue://3164"]);

		const pr = suggestions!.items[0]!;
		const issue = suggestions!.items[1]!;
		const prResult = provider.applyCompletion(["review #3164"], 0, 12, pr, suggestions!.prefix);
		expect(prResult.lines).toEqual(["review pr://3164 "]);
		expect(prResult.cursorCol).toBe("review pr://3164 ".length);

		const issueResult = provider.applyCompletion(["review #3164"], 0, 12, issue, suggestions!.prefix);
		expect(issueResult.lines).toEqual(["review issue://3164 "]);
	});

	it("offers GitHub references inside prompt-bearing skill command arguments", async () => {
		const provider = makeProvider([{ name: "skill:code-review", description: "Review code", allowArgs: true }]);
		const line = "/skill:code-review inspect #123";

		const suggestions = await provider.getSuggestions([line], 0, line.length);

		expect(suggestions).toEqual({
			prefix: "#123",
			items: [
				{ value: "pr://123", label: "PR #123", description: "GitHub pull request" },
				{ value: "issue://123", label: "Issue #123", description: "GitHub issue" },
			],
		});
	});

	it("constrains to the named type and consumes the qualifier on accept", async () => {
		const provider = makeProvider();
		const suggestions = await provider.getSuggestions(["review pr #3164"], 0, 15);
		expect(suggestions).not.toBeNull();
		expect(suggestions!.prefix).toBe("pr #3164");
		expect(suggestions!.items.map(item => item.value)).toEqual(["pr://3164"]);

		const pr = suggestions!.items[0]!;
		const result = provider.applyCompletion(["review pr #3164"], 0, 15, pr, suggestions!.prefix);
		// the "pr " qualifier is replaced along with the number, not left dangling
		expect(result.lines).toEqual(["review pr://3164 "]);
	});

	it("revalidates stale prefixes against the live cursor token before applying", async () => {
		const provider = makeProvider();
		const staleSuggestions = await provider.getSuggestions(["review #316"], 0, 11);
		expect(staleSuggestions).not.toBeNull();
		const stalePr = staleSuggestions!.items[0]!;

		const updatedNumber = provider.applyCompletion(["review #3164"], 0, 12, stalePr, staleSuggestions!.prefix);
		expect(updatedNumber.lines).toEqual(["review pr://3164 "]);
		expect(updatedNumber.cursorCol).toBe("review pr://3164 ".length);

		const embeddedHash = provider.applyCompletion(["owner/repo#3164"], 0, 15, stalePr, staleSuggestions!.prefix);
		expect(embeddedHash.lines).toEqual(["owner/repo#3164"]);
		expect(embeddedHash.cursorCol).toBe(15);
	});

	it("does not offer candidates for embedded hashes (falls through to other providers)", async () => {
		const provider = makeProvider();
		const isRef = (value: string) => value.startsWith("pr://") || value.startsWith("issue://");
		const embedded = await provider.getSuggestions(["owner/repo#3164"], 0, 15);
		expect(embedded?.items.every(item => !isRef(item.value)) ?? true).toBe(true);
	});
});
