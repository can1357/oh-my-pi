/**
 * Regression test for #1496 (bug 2): `omp install ./my-extension` used to be
 * silently rewritten to `launch install ./my-extension` and forwarded to the
 * LLM as an initial prompt because no top-level `install` subcommand existed.
 *
 * These tests pin two invariants:
 *
 *  1. `install` is registered in the CLI command table, so the runner does
 *     not prepend `launch` and the args never reach the model.
 *  2. The local-path heuristic that routes `install ./foo` to `plugin link`
 *     while routing remote specs to `plugin install` is correct for the
 *     shapes users actually type.
 */
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { commands, isSubcommand, resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { looksLikeLocalPath } from "@oh-my-pi/pi-coding-agent/commands/install";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("install command is registered as a top-level subcommand", () => {
	test("CLI runner sees `install` as a known command", () => {
		expect(commands.some(c => c.name === "install")).toBe(true);
		expect(isSubcommand("install")).toBe(true);
	});

	test("CLI runner rejects only bare reserved management words", () => {
		expect(resolveCliArgv(["extensions"])).toEqual({
			error: '`omp extensions` is not a management command. Use `omp plugin list` / `omp plugin install`, or run `omp launch extensions` if you meant to send "extensions" as a prompt.',
		});
		expect(resolveCliArgv(["extensions", "are", "not", "loading"])).toEqual({
			argv: ["launch", "extensions", "are", "not", "loading"],
		});
		expect(resolveCliArgv(["launch", "extensions"])).toEqual({ argv: ["launch", "extensions"] });
	});
});

describe("looksLikeLocalPath", () => {
	test("explicit relative paths are local", () => {
		expect(looksLikeLocalPath("./my-extension")).toBe(true);
		expect(looksLikeLocalPath("../sibling")).toBe(true);
		expect(looksLikeLocalPath(".")).toBe(true);
	});

	test("absolute and home-relative paths are local", () => {
		expect(looksLikeLocalPath("/usr/local/share/ext")).toBe(true);
		expect(looksLikeLocalPath("~/extensions/foo")).toBe(true);
	});

	test("Windows drive-prefixed paths are local", () => {
		expect(looksLikeLocalPath("C:\\extensions\\foo")).toBe(true);
		expect(looksLikeLocalPath("D:/extensions/foo")).toBe(true);
	});

	test("npm specs and marketplace refs are remote", () => {
		expect(looksLikeLocalPath("@oh-my-pi/exa")).toBe(false);
		expect(looksLikeLocalPath("my-pkg")).toBe(false);
		expect(looksLikeLocalPath("my-pkg@1.2.3")).toBe(false);
		expect(looksLikeLocalPath("name@marketplace")).toBe(false);
	});

	test("bare names that exist as a local directory are treated as local", () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-install-test-"));
		try {
			fs.mkdirSync(path.join(tempDir, "vendored-ext"));
			expect(looksLikeLocalPath("vendored-ext", tempDir)).toBe(true);
			expect(looksLikeLocalPath("missing-pkg", tempDir)).toBe(false);
		} finally {
			removeSyncWithRetries(tempDir);
		}
	});
});
