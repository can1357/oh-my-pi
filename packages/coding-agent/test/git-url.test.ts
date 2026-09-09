import { describe, expect, test } from "bun:test";
import { isGitSpec, parseGitUrl } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/git-url";

describe("parseGitUrl", () => {
	describe("protocol URLs (accepted without git: prefix)", () => {
		test("parses https URL", () => {
			const result = parseGitUrl("https://github.com/user/repo");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
				pinned: false,
			});
		});

		test("parses ssh URL", () => {
			const result = parseGitUrl("ssh://git@github.com/user/repo");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "ssh://git@github.com/user/repo",
				pinned: false,
			});
		});

		test("parses git protocol URL", () => {
			const result = parseGitUrl("git://github.com/user/repo");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "git://github.com/user/repo",
				pinned: false,
			});
		});
	});

	describe("shorthand URLs (accepted only with git: prefix)", () => {
		test("parses host/path shorthand with git: prefix", () => {
			const result = parseGitUrl("git:github.com/user/repo");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
				pinned: false,
			});
		});

		test("parses scp-like ssh shorthand with git: prefix", () => {
			const result = parseGitUrl("git:git@github.com:user/repo@v1.0.0");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "git@github.com:user/repo",
				ref: "v1.0.0",
				pinned: true,
			});
		});
	});

	describe("local paths and unprefixed shorthand", () => {
		test("rejects unprefixed host/path shorthand", () => {
			expect(parseGitUrl("github.com/user/repo")).toBeNull();
		});

		test("parses unprefixed scp-like SSH shorthand", () => {
			const result = parseGitUrl("git@github.com:user/repo");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "git@github.com:user/repo",
				pinned: false,
			});
		});

		test("parses unprefixed scp-like SSH shorthand with ref", () => {
			const result = parseGitUrl("git@github.com:user/repo@v1.0.0");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "git@github.com:user/repo",
				ref: "v1.0.0",
				pinned: true,
			});
		});

		test("parses git+https URL", () => {
			const result = parseGitUrl("git+https://github.com/user/repo");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
				pinned: false,
			});
		});

		test("parses git+ssh URL", () => {
			const result = parseGitUrl("git+ssh://git@github.com/user/repo");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				pinned: false,
			});
		});

		test("does not misclassify local paths containing dots", () => {
			expect(parseGitUrl("plugins.v2/my-plugin")).toBeNull();
			expect(parseGitUrl("vendor/github.enterprise/tools")).toBeNull();
		});
	});

	describe("namespaced shorthand (github:user/repo, gitlab:, …)", () => {
		test("parses github: shorthand", () => {
			expect(parseGitUrl("github:user/repo")).toEqual({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
				ref: undefined,
				pinned: false,
			});
		});

		test("captures #ref and marks pinned", () => {
			const result = parseGitUrl("github:user/repo#v1.0");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
				ref: "v1.0",
				pinned: true,
			});
		});

		test("strips trailing .git from the path", () => {
			const result = parseGitUrl("github:user/repo.git");
			expect(result).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
				pinned: false,
			});
		});

		test("maps gitlab: to gitlab.com", () => {
			expect(parseGitUrl("gitlab:user/repo")).toMatchObject({
				type: "git",
				host: "gitlab.com",
				path: "user/repo",
				repo: "https://gitlab.com/user/repo",
			});
		});

		test("maps bitbucket: to bitbucket.org", () => {
			expect(parseGitUrl("bitbucket:user/repo")).toMatchObject({
				type: "git",
				host: "bitbucket.org",
				path: "user/repo",
				repo: "https://bitbucket.org/user/repo",
			});
		});

		test("maps codeberg: to codeberg.org", () => {
			expect(parseGitUrl("codeberg:user/repo")).toMatchObject({
				type: "git",
				host: "codeberg.org",
				path: "user/repo",
				repo: "https://codeberg.org/user/repo",
			});
		});

		test("maps sourcehut: and srht: to git.sr.ht", () => {
			expect(parseGitUrl("sourcehut:user/repo")).toMatchObject({
				type: "git",
				host: "git.sr.ht",
				path: "user/repo",
				repo: "https://git.sr.ht/user/repo",
			});
			expect(parseGitUrl("srht:user/repo")).toMatchObject({
				type: "git",
				host: "git.sr.ht",
				path: "user/repo",
				repo: "https://git.sr.ht/user/repo",
			});
		});

		test("rejects missing repo segment", () => {
			expect(parseGitUrl("github:user")).toBeNull();
		});

		test("rejects empty body", () => {
			expect(parseGitUrl("github:")).toBeNull();
		});

		test("rejects unknown shorthand prefix", () => {
			expect(parseGitUrl("notahost:user/repo")).toBeNull();
		});

		test("does not swallow protocol URLs (regression)", () => {
			expect(parseGitUrl("https://github.com/user/repo")).toMatchObject({
				type: "git",
				host: "github.com",
				path: "user/repo",
				repo: "https://github.com/user/repo",
			});
		});
	});
});

describe("isGitSpec", () => {
	test("returns true for namespaced shorthand", () => {
		expect(isGitSpec("github:user/repo")).toBe(true);
	});

	test("returns true for https git URLs", () => {
		expect(isGitSpec("https://github.com/user/repo")).toBe(true);
	});

	test("returns true for unprefixed scp-like SSH (git@host:user/repo)", () => {
		expect(isGitSpec("git@github.com:user/repo")).toBe(true);
	});

	test("returns true for git+https URLs", () => {
		expect(isGitSpec("git+https://github.com/user/repo")).toBe(true);
	});

	test("returns false for bare npm name", () => {
		expect(isGitSpec("my-plugin")).toBe(false);
	});

	test("returns false for scoped npm name", () => {
		expect(isGitSpec("@scope/pkg")).toBe(false);
	});

	test("returns false for scoped npm name with version", () => {
		expect(isGitSpec("@scope/pkg@1.2.3")).toBe(false);
	});
});
