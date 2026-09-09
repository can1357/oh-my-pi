import { describe, expect, test } from "bun:test";
import {
	canReuseCachedPr,
	createPrCacheContext,
	isSamePrCacheContext,
	parseDefaultBranch,
	parseGitHubRepo,
} from "@oh-my-pi/pi-coding-agent/modes/components/status-line/git-utils";

describe("parseGitHubRepo", () => {
	test("parses HTTPS URL", () => {
		expect(parseGitHubRepo("https://github.com/can1357/oh-my-pi.git")).toBe("can1357/oh-my-pi");
	});

	test("parses HTTPS URL without .git suffix", () => {
		expect(parseGitHubRepo("https://github.com/can1357/oh-my-pi")).toBe("can1357/oh-my-pi");
	});

	test("parses SSH scp-style URL", () => {
		expect(parseGitHubRepo("git@github.com:loftiskg/oh-my-pi.git")).toBe("loftiskg/oh-my-pi");
	});

	test("parses SSH scp-style URL without .git suffix", () => {
		expect(parseGitHubRepo("git@github.com:loftiskg/oh-my-pi")).toBe("loftiskg/oh-my-pi");
	});

	test("parses ssh:// protocol URL", () => {
		expect(parseGitHubRepo("ssh://git@github.com/user/repo.git")).toBe("user/repo");
	});

	test("returns null for non-GitHub URL", () => {
		expect(parseGitHubRepo("https://gitlab.com/user/repo.git")).toBeNull();
	});

	test("handles GitHub Enterprise-style URLs (no match)", () => {
		expect(parseGitHubRepo("https://github.corp.com/org/repo.git")).toBeNull();
	});

	test("parses HTTPS URL with dots in repo name", () => {
		expect(parseGitHubRepo("https://github.com/org/my.repo.name.git")).toBe("org/my.repo.name");
	});

	test("parses SSH URL with dots in repo name", () => {
		expect(parseGitHubRepo("git@github.com:org/dotted.repo.git")).toBe("org/dotted.repo");
	});

	test("parses URL with dots in repo name and no .git suffix", () => {
		expect(parseGitHubRepo("https://github.com/org/my.repo")).toBe("org/my.repo");
	});
});

describe("parseDefaultBranch", () => {
	test("strips origin/ prefix from origin/main", () => {
		expect(parseDefaultBranch("origin/main")).toBe("main");
	});

	test("strips origin/ prefix from origin/master", () => {
		expect(parseDefaultBranch("origin/master")).toBe("master");
	});

	test("strips origin/ prefix from origin/develop", () => {
		expect(parseDefaultBranch("origin/develop")).toBe("develop");
	});

	test("strips upstream/ prefix", () => {
		expect(parseDefaultBranch("upstream/main")).toBe("main");
	});

	test("returns bare branch name unchanged", () => {
		expect(parseDefaultBranch("main")).toBe("main");
	});

	test("handles empty string", () => {
		expect(parseDefaultBranch("")).toBe("");
	});
});

describe("isSamePrCacheContext", () => {
	test("returns true when branch and repo match", () => {
		expect(
			isSamePrCacheContext(
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
			),
		).toBe(true);
	});

	test("returns false when repo changes but branch stays the same", () => {
		expect(
			isSamePrCacheContext(
				createPrCacheContext("feature/one", "/repo-a/.git/HEAD"),
				createPrCacheContext("feature/one", "/repo-b/.git/HEAD"),
			),
		).toBe(false);
	});
});

describe("canReuseCachedPr", () => {
	test("allows negative-cache reuse when context is unchanged", () => {
		expect(
			canReuseCachedPr(
				null,
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
			),
		).toBe(true);
	});

	test("rejects cached PR when branch changes", () => {
		expect(
			canReuseCachedPr(
				{ number: 12, url: "https://example.test/pr/12" },
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
				createPrCacheContext("feature/two", "/repo/.git/HEAD"),
			),
		).toBe(false);
	});

	test("rejects cached PR when repo context is unavailable", () => {
		expect(
			canReuseCachedPr(
				{ number: 12, url: "https://example.test/pr/12" },
				createPrCacheContext("feature/one", "/repo/.git/HEAD"),
				null,
			),
		).toBe(false);
	});
});
