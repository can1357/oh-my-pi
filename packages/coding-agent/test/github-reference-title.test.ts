/**
 * `lookupCachedReferenceTitle` feeds the caption of the contextual `#N` card on every frame, so it must be a
 * pure local read. Each test points `OMP_GITHUB_CACHE_DB` at a temp file, so the user's real cache is never read,
 * pins the credential environment that keys the cache, and clears the process-wide repository map that the lookup
 * depends on. Views are written through `getOrFetchView`, the path `pr://` and `issue://` reads use.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_REPO_RESOLVED } from "@oh-my-pi/pi-coding-agent/tools/gh-common";
import {
	getOrFetchView,
	resetForTests as resetCacheForTests,
	resolveGithubCacheAuthKey,
} from "@oh-my-pi/pi-coding-agent/tools/github-cache";
import {
	fetchReferenceTitle,
	lookupCachedReferenceTitle,
	resetReferenceRepoAttempts,
	resetReferenceTitleFetches,
	warmReferenceRepo,
} from "@oh-my-pi/pi-coding-agent/tools/github-reference-title";
import * as ghView from "@oh-my-pi/pi-coding-agent/tools/gh-view";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

const ENV_KEYS = [
	"OMP_GITHUB_CACHE_DB",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"GH_CONFIG_DIR",
];

let tempDir: string;
let cwd: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	for (const key of ENV_KEYS) delete process.env[key];
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-reference-title-"));
	process.env.OMP_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	process.env.GH_CONFIG_DIR = path.join(tempDir, "gh-config");
	process.env.GH_TOKEN = "token-one";
	resetCacheForTests();
	DEFAULT_REPO_RESOLVED.clear();
	cwd = path.join(tempDir, "checkout");
	DEFAULT_REPO_RESOLVED.set(path.resolve(cwd), "owner/example");
});

afterEach(async () => {
	DEFAULT_REPO_RESOLVED.clear();
	resetCacheForTests();
	for (const key of ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	await removeWithRetries(tempDir);
});

/** Store a view the way a real read does: under the identity key of the active credentials. */
async function cache(
	kind: "issue" | "pr",
	number: number,
	title: string,
	includeComments = false,
	url?: string,
): Promise<void> {
	const authKey = resolveGithubCacheAuthKey();
	expect(authKey).toBeDefined();
	await getOrFetchView({
		repo: "owner/example",
		kind,
		number,
		includeComments,
		authKey,
		fetchFresh: async () => ({
			rendered: `${kind} ${number}`,
			sourceUrl: undefined,
			payload: { number, title, url },
		}),
	});
}

describe("lookupCachedReferenceTitle", () => {
	it("returns the cached title for each kind of reference independently", async () => {
		await cache("pr", 12, "Fix the resize replay");
		await cache("issue", 12, "Popup covers the input");

		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBe("Fix the resize replay");
		expect(lookupCachedReferenceTitle(cwd, "issue", "12")).toBe("Popup covers the input");
	});

	it("shows no issue title for a number that is a pull request", async () => {
		// `gh issue view` answers for a PR number, so the issue row can hold the PR.
		await cache("issue", 11207, "Adds the advisor page", false, "https://github.com/owner/example/pull/11207");
		await cache("issue", 12, "Popup covers the input", false, "https://github.com/owner/example/issues/12");

		expect(lookupCachedReferenceTitle(cwd, "issue", "11207")).toBeUndefined();
		expect(lookupCachedReferenceTitle(cwd, "issue", "12")).toBe("Popup covers the input");
	});

	it("finds a title that was cached by a view with comments", async () => {
		await cache("pr", 7, "Only viewed with comments", true);

		expect(lookupCachedReferenceTitle(cwd, "pr", "7")).toBe("Only viewed with comments");
	});

	it("returns nothing for a number that was never opened", async () => {
		await cache("pr", 12, "Fix the resize replay");

		expect(lookupCachedReferenceTitle(cwd, "pr", "13")).toBeUndefined();
		expect(lookupCachedReferenceTitle(cwd, "issue", "12")).toBeUndefined();
	});

	it("returns nothing until the checkout's repository is known, without starting a lookup", async () => {
		await cache("pr", 12, "Fix the resize replay");
		DEFAULT_REPO_RESOLVED.clear();

		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();
		expect(DEFAULT_REPO_RESOLVED.size).toBe(0);
	});

	it("resolves the repository for the checkout it is asked about, not another one", async () => {
		await cache("pr", 12, "Fix the resize replay");
		DEFAULT_REPO_RESOLVED.set(path.resolve(path.join(tempDir, "other")), "owner/elsewhere");

		expect(lookupCachedReferenceTitle(path.join(tempDir, "other"), "pr", "12")).toBeUndefined();
		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBe("Fix the resize replay");
	});

	it("ignores tokens that are not positive integers", async () => {
		await cache("pr", 12, "Fix the resize replay");

		for (const token of ["0", "-1", "1.5", "abc", "", "99999999999999999999"]) {
			expect(lookupCachedReferenceTitle(cwd, "pr", token)).toBeUndefined();
		}
	});

	it("skips a cached view whose title is empty", async () => {
		await cache("pr", 12, "   ");

		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();
	});

	it("shows a title only to the identity that cached it, and nothing without an identity", async () => {
		await cache("pr", 12, "Cached by account one");
		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBe("Cached by account one");

		process.env.GH_TOKEN = "token-two";
		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();

		delete process.env.GH_TOKEN;
		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();
	});
});

describe("warmReferenceRepo", () => {
	beforeEach(() => resetReferenceRepoAttempts());
	afterEach(() => vi.restoreAllMocks());

	it("makes a cached title appear in a session that has not run any GitHub tool yet", async () => {
		await cache("pr", 12, "Fix the resize replay");
		DEFAULT_REPO_RESOLVED.clear();
		vi.spyOn(github, "text").mockResolvedValue("https://github.com/owner/example");
		// The fresh-session state the card starts from: cached, but the checkout's repository is unknown.
		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBeUndefined();

		const ready = Promise.withResolvers<void>();
		warmReferenceRepo(cwd, () => ready.resolve());
		await ready.promise;

		expect(lookupCachedReferenceTitle(cwd, "pr", "12")).toBe("Fix the resize replay");
	});

	it("tries a checkout that cannot be resolved once, not on every frame the card is drawn", async () => {
		DEFAULT_REPO_RESOLVED.clear();
		const text = vi.spyOn(github, "text").mockRejectedValue(new Error("no remote"));
		let ready = 0;
		for (let frame = 0; frame < 20; frame++) {
			warmReferenceRepo(cwd, () => ready++);
			await Bun.sleep(1);
		}
		await Bun.sleep(20);

		expect(text).toHaveBeenCalledTimes(1);
		expect(ready).toBe(0);
	});

	it("does not ask at all once the repository is known", () => {
		const text = vi.spyOn(github, "text").mockRejectedValue(new Error("must not run"));
		warmReferenceRepo(cwd, () => {});

		expect(text).not.toHaveBeenCalled();
	});
});

describe("fetchReferenceTitle", () => {
	beforeEach(() => resetReferenceTitleFetches());
	afterEach(() => {
		resetReferenceTitleFetches();
		vi.restoreAllMocks();
	});

	function stubView(kind: "pr" | "issue", title: string) {
		const payload = { number: 0, title };
		return vi
			.spyOn(ghView, kind === "pr" ? "fetchPrViewFresh" : "fetchIssueViewFresh")
			.mockImplementation(async () => ({ rendered: title, sourceUrl: undefined, payload }) as never);
	}

	it("fetches only the number the user settled on and makes its title readable afterwards", async () => {
		const fetch = stubView("pr", "Adds the advisor page");
		const ready = Promise.withResolvers<void>();
		for (const typed of ["1", "12", "120", "1120", "11207"])
			fetchReferenceTitle(cwd, "pr", typed, () => ready.resolve());
		await ready.promise;

		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch.mock.calls[0]![2]).toBe(11207);
		expect(lookupCachedReferenceTitle(cwd, "pr", "11207")).toBe("Adds the advisor page");
		expect(lookupCachedReferenceTitle(cwd, "pr", "1120")).toBeUndefined();
	});

	it("does not ask again for a reference it already requested, even when it failed", async () => {
		const fetch = vi.spyOn(ghView, "fetchPrViewFresh").mockRejectedValue(new Error("not found"));
		for (let round = 0; round < 3; round++) {
			fetchReferenceTitle(cwd, "pr", "999", () => {});
			await Bun.sleep(550);
		}

		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("stays local when the repository is unknown or the GitHub cache is disabled", async () => {
		const fetch = stubView("pr", "never fetched");
		DEFAULT_REPO_RESOLVED.clear();
		fetchReferenceTitle(cwd, "pr", "5", () => {});
		DEFAULT_REPO_RESOLVED.set(path.resolve(cwd), "owner/example");
		fetchReferenceTitle(cwd, "pr", "5", () => {}, Settings.isolated({ "github.cache.enabled": false }));
		await Bun.sleep(550);

		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not fetch what the cache already has", async () => {
		await cache("pr", 12, "Already here");
		const fetch = stubView("pr", "must not run");
		fetchReferenceTitle(cwd, "pr", "12", () => {});
		await Bun.sleep(550);

		expect(fetch).not.toHaveBeenCalled();
	});
});
