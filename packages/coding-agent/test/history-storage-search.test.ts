import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;

async function freshStorage(): Promise<HistoryStorage> {
	tempDir = TempDir.createSync("@omp-history-search-");
	HistoryStorage.close();
	return HistoryStorage.open(tempDir.join("history.db"));
}

async function seed(storage: HistoryStorage, prompts: string[]): Promise<void> {
	const writes = prompts.map(prompt => storage.add(prompt, "/tmp/test"));
	vi.advanceTimersByTime(100);
	await Promise.all(writes);
}

beforeEach(() => {
	HistoryStorage.close();
	vi.useFakeTimers();
});

afterEach(async () => {
	HistoryStorage.close();
	vi.useRealTimers();
	if (tempDir) {
		await Bun.sleep(0);
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("HistoryStorage.search", () => {
	it("requires literal punctuation within each query term", async () => {
		const storage = await freshStorage();
		await seed(storage, ["see a/b path", "alpha and beta note", "see a b path", "unrelated"]);

		expect(storage.search("a/b", 10).map(r => r.prompt)).toEqual(["see a/b path"]);
	});

	it("does not turn a hyphenated term into two independent words", async () => {
		const storage = await freshStorage();
		await seed(storage, ["run git-commit now", "run git commit --amend now"]);

		expect(storage.search("git-commit", 10).map(r => r.prompt)).toEqual(["run git-commit now"]);
	});

	it("requires both a literal path and another query term", async () => {
		const storage = await freshStorage();
		await seed(storage, ["see a/b path", "see a/b note", "alpha and beta path"]);

		expect(storage.search("a/b path", 10).map(r => r.prompt)).toEqual(["see a/b path"]);
	});

	it("does not return diacritic-folded FTS matches without the literal term", async () => {
		const storage = await freshStorage();
		await seed(storage, ["a café is here", "a cafe is here"]);

		expect(storage.search("cafe", 10).map(r => r.prompt)).toEqual(["a cafe is here"]);
	});

	it("falls back to substring matching for infix queries FTS prefix cannot reach", async () => {
		const storage = await freshStorage();
		await seed(storage, ["run git commit later", "totally unrelated text"]);

		// FTS5 `*` is prefix-only — `mit` cannot match `commit` via FTS.
		// Substring fallback must catch it.
		const results = storage.search("mit", 10);
		expect(results.map(r => r.prompt)).toEqual(["run git commit later"]);
	});

	it("AND's substring tokens so multi-word infix queries narrow results", async () => {
		const storage = await freshStorage();
		await seed(storage, [
			"commit and amend the patch",
			"commit only without the other",
			"amend only without the other",
		]);

		// Each token must appear (as substring). `mit` is infix of `commit`, so FTS
		// returns nothing; substring fallback must AND both tokens.
		const results = storage.search("mit amend", 10);
		expect(results.map(r => r.prompt)).toEqual(["commit and amend the patch"]);
	});

	it("returns merged FTS and substring fallback matches by recency", async () => {
		const storage = await freshStorage();
		// Insert oldest -> newest. The newest row is substring-only; it must not
		// be pushed behind older FTS prefix matches in Ctrl+R results.
		await seed(storage, ["commit the changes", "precommit hook fix"]);

		const results = storage.search("commit", 10);
		expect(results.map(r => r.prompt)).toEqual([
			"precommit hook fix", // substring-only (`commit` is infix of `precommit`)
			"commit the changes", // FTS prefix match on token `commit`
		]);
	});

	it("matches case-insensitively for substring fallback", async () => {
		const storage = await freshStorage();
		await seed(storage, ["Recommit The Patch"]);

		const results = storage.search("MIT", 10);
		expect(results.map(r => r.prompt)).toEqual(["Recommit The Patch"]);
	});

	it("matches punctuation-only terms literally and ignores empty queries", async () => {
		const storage = await freshStorage();
		await seed(storage, ["one --- two", "one two", "100% complete", "1000 complete"]);

		expect(storage.search("---", 10).map(r => r.prompt)).toEqual(["one --- two"]);
		expect(storage.search("100%", 10).map(r => r.prompt)).toEqual(["100% complete"]);
		expect(storage.search("  ", 10)).toEqual([]);
	});

	it("respects the limit after globally sorting merged FTS and substring results", async () => {
		const storage = await freshStorage();
		await seed(storage, ["commit one", "commit two", "precommit three", "precommit four"]);

		const results = storage.search("commit", 2);
		expect(results).toHaveLength(2);
		expect(results.map(r => r.prompt)).toEqual(["precommit four", "precommit three"]);
	});

	it("matches short tokens via the substring fallback", async () => {
		const storage = await freshStorage();
		await seed(storage, ["go run main", "node script"]);

		// Defends short-query (<= 2 char) matching end-to-end.
		const results = storage.search("go", 10);
		expect(results.map(r => r.prompt)).toEqual(["go run main"]);
	});

	it("AND's tokens correctly when one is short and one is an infix", async () => {
		const storage = await freshStorage();
		await seed(storage, ["go commit changes", "go run main", "commit changes"]);

		// `go` matches via FTS, `mit` only matches via substring (infix of commit).
		// Combined: only `go commit changes` satisfies both as substrings.
		const results = storage.search("go mit", 10);
		expect(results.map(r => r.prompt)).toEqual(["go commit changes"]);
	});
});
