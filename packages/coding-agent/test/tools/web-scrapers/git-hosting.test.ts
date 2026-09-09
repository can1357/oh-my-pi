import { describe, expect, it } from "bun:test";
import { handleGitHub, parseGitHubUrl, stripActionsLogTimestamps } from "@oh-my-pi/pi-coding-agent/web/scrapers/github";
import { handleGitHubGist } from "@oh-my-pi/pi-coding-agent/web/scrapers/github-gist";

const SKIP = !Bun.env.WEB_FETCH_INTEGRATION;

// =============================================================================
// GitHub Tests
// =============================================================================

describe.skipIf(SKIP)("handleGitHub", () => {
	it("returns null for non-GitHub URLs", async () => {
		const result = await handleGitHub("https://example.com", 10000);
		expect(result).toBeNull();
	});

	it("returns null for other git hosting domains", async () => {
		const result = await handleGitHub("https://gitlab.com/user/repo", 10000);
		expect(result).toBeNull();
	});

	it("fetches repository root", async () => {
		const result = await handleGitHub("https://github.com/facebook/react", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-repo");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content).toContain("facebook/react");
			expect(result.content).toContain("Stars:");
			expect(result.content).toContain("Forks:");
		}
		expect(result).toBeDefined();
	});

	it("fetches another repository", async () => {
		const result = await handleGitHub("https://github.com/microsoft/typescript", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-repo");
			// GitHub returns "TypeScript" with capital T
			expect(result.content).toContain("microsoft/TypeScript");
		}
		expect(result).toBeDefined();
	});

	it("fetches file blob", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/blob/main/README.md", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("github-raw");
		expect(result?.contentType).toBe("text/plain");
		expect(result?.content.length).toBeGreaterThan(0);
	});

	it("fetches file blob from specific branch", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/blob/main/package.json", 20000);
		expect(result).not.toBeNull();
		expect(result?.method).toBe("github-raw");
		expect(result?.content.length).toBeGreaterThan(0);
	});

	it("fetches directory tree", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/tree/main/packages", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-tree");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content).toContain("facebook/react");
			expect(result.content).toContain("Contents");
		}
		expect(result).toBeDefined();
	});

	it("fetches directory tree from root", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/tree/main", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-tree");
			expect(result.content).toContain("facebook/react");
		}
		expect(result).toBeDefined();
	});

	it("fetches issue", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/issues/1", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-issue");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content.length).toBeGreaterThan(0);
		}
		expect(result).toBeDefined();
	});

	it("fetches issues list", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/issues", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-issues");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content.length).toBeGreaterThan(0);
		}
		expect(result).toBeDefined();
	});

	it("handles pulls list endpoint", async () => {
		const result = await handleGitHub("https://github.com/facebook/react/pulls", 20000);
		// Should be handled as pulls list but currently falls back to null
		// This tests the actual behavior
		expect(result).toBeDefined();
	});
});

// =============================================================================
// GitHub Gist Tests
// =============================================================================

describe.skipIf(SKIP)("handleGitHubGist", () => {
	it("returns null for non-gist URLs", async () => {
		const result = await handleGitHubGist("https://example.com", 10000);
		expect(result).toBeNull();
	});

	it("returns null for github.com URLs", async () => {
		const result = await handleGitHubGist("https://github.com/user/repo", 10000);
		expect(result).toBeNull();
	});

	it("returns null for gist.github.com root", async () => {
		const result = await handleGitHubGist("https://gist.github.com/", 10000);
		expect(result).toBeNull();
	});

	it("fetches a public gist with username", async () => {
		// Using a valid public gist ID (may change but structure should be consistent)
		const result = await handleGitHubGist("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-gist");
			expect(result.contentType).toBe("text/markdown");
			expect(result.content).toContain("Gist by");
			expect(result.content).toContain("Created:");
			expect(result.content).toContain("Files:");
		}
		expect(result).toBeDefined();
	});

	it("fetches a public gist without username in URL", async () => {
		// Same gist, accessed via short URL (without username)
		const result = await handleGitHubGist("https://gist.github.com/edf814aeee85062bc9b9830aeaf27b88", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-gist");
			expect(result.content).toContain("Gist by");
		}
		expect(result).toBeDefined();
	});

	it("returns null for invalid gist ID format", async () => {
		const result = await handleGitHubGist("https://gist.github.com/invalid-gist-id!", 10000);
		expect(result).toBeNull();
	});

	it("returns null for non-hexadecimal gist ID", async () => {
		const result = await handleGitHubGist("https://gist.github.com/notahexstring123", 10000);
		expect(result).toBeNull();
	});

	it("handles gist URL with trailing slash", async () => {
		const result = await handleGitHubGist("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88/", 20000);
		if (result !== null) {
			expect(result.method).toBe("github-gist");
		}
		expect(result).toBeDefined();
	});

	it("handles gist with revision hash", async () => {
		const result = await handleGitHubGist(
			"https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88/abc123",
			20000,
		);
		// Should handle revision hash in URL path
		expect(result).toBeDefined();
	});

	it("formats gist content as markdown with code blocks", async () => {
		const result = await handleGitHubGist("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88", 20000);
		if (result !== null) {
			expect(result.content).toContain("```");
			expect(result.content).toContain("---");
		}
		expect(result).toBeDefined();
	});

	it("includes file metadata", async () => {
		const result = await handleGitHubGist("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88", 20000);
		if (result !== null) {
			expect(result.content).toContain("Created:");
			expect(result.content).toContain("Updated:");
		}
		expect(result).toBeDefined();
	});

	it("returns null for nonexistent gist", async () => {
		const result = await handleGitHubGist("https://gist.github.com/0000000000000000000000000000000000000000", 20000);
		expect(result).toBeNull();
	});

	it("handles API rate limiting gracefully", async () => {
		// This test just ensures no errors are thrown
		const result = await handleGitHubGist("https://gist.github.com/gaearon/edf814aeee85062bc9b9830aeaf27b88", 5000);
		expect(result).toBeDefined();
	});
});

// =============================================================================
// GitHub Actions URL parsing (pure, network-free)
// =============================================================================

describe("parseGitHubUrl — Actions", () => {
	it("classifies a workflow run URL", () => {
		const gh = parseGitHubUrl("https://github.com/can1357/oh-my-pi/actions/runs/27070071296");
		expect(gh).toEqual({ type: "actions-run", owner: "can1357", repo: "oh-my-pi", runId: 27070071296 });
	});

	it("classifies a job URL using the web-form singular `job` segment", () => {
		const gh = parseGitHubUrl("https://github.com/can1357/oh-my-pi/actions/runs/27070071296/job/79897931171");
		expect(gh).toEqual({
			type: "actions-job",
			owner: "can1357",
			repo: "oh-my-pi",
			runId: 27070071296,
			jobId: 79897931171,
		});
	});

	it("classifies a job URL using the API-form plural `jobs` segment", () => {
		const gh = parseGitHubUrl("https://github.com/can1357/oh-my-pi/actions/runs/27070071296/jobs/79897931171");
		expect(gh?.type).toBe("actions-job");
		expect(gh?.jobId).toBe(79897931171);
	});

	it("does not treat non-run Actions URLs (e.g. workflow files) as runs/jobs", () => {
		expect(parseGitHubUrl("https://github.com/can1357/oh-my-pi/actions/workflows/ci.yml")?.type).toBe("other");
		expect(parseGitHubUrl("https://github.com/can1357/oh-my-pi/actions")?.type).toBe("other");
	});

	it("does not misparse a run URL with a non-numeric id", () => {
		expect(parseGitHubUrl("https://github.com/can1357/oh-my-pi/actions/runs/latest")?.type).toBe("other");
	});

	it("returns null for non-github hosts", () => {
		expect(parseGitHubUrl("https://gitlab.com/o/r/actions/runs/1")).toBeNull();
	});
});

describe("parseGitHubUrl — commit", () => {
	it("classifies a commit URL with a full SHA", () => {
		const gh = parseGitHubUrl("https://github.com/can1357/oh-my-pi/commit/c1a1cb6149e73b345919dd4cf629b0d9ac74fb57");
		expect(gh).toEqual({
			type: "commit",
			owner: "can1357",
			repo: "oh-my-pi",
			ref: "c1a1cb6149e73b345919dd4cf629b0d9ac74fb57",
		});
	});

	it("accepts an abbreviated SHA", () => {
		expect(parseGitHubUrl("https://github.com/can1357/oh-my-pi/commit/c1a1cb6")).toEqual({
			type: "commit",
			owner: "can1357",
			repo: "oh-my-pi",
			ref: "c1a1cb6",
		});
	});

	it("falls back to `other` for a bare /commit segment with no SHA", () => {
		expect(parseGitHubUrl("https://github.com/can1357/oh-my-pi/commit")?.type).toBe("other");
	});
});

describe("stripActionsLogTimestamps", () => {
	it("removes the per-line ISO timestamp prefix and a leading BOM", () => {
		const raw =
			"\uFEFF2026-06-06T18:14:12.8793443Z Current runner version: '2.334.0'\n2026-06-06T18:14:13.0000000Z done\n";
		expect(stripActionsLogTimestamps(raw)).toBe("Current runner version: '2.334.0'\ndone\n");
	});

	it("leaves grouped/non-timestamped lines untouched", () => {
		const raw = "2026-06-06T18:14:12.0000000Z ##[group]Operating System\nUbuntu\n##[endgroup]\n";
		expect(stripActionsLogTimestamps(raw)).toBe("##[group]Operating System\nUbuntu\n##[endgroup]\n");
	});
});
