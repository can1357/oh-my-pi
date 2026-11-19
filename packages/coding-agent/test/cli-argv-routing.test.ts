/**
 * Leading global option flags must not hide a subcommand from the CLI runner.
 *
 * #2970: `omp --approval-mode=yolo acp` was rewritten to
 * `launch --approval-mode=yolo acp`, swallowing `acp` as a launch prompt so the
 * yolo override never reached the ACP command path. The resolver now skips
 * leading global flags (using the launch parser's value-consumption contract)
 * and hoists the real subcommand to the front so its parser still applies the
 * flags.
 */
import { describe, expect, test } from "bun:test";
import { resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";

describe("resolveCliArgv routes subcommands hidden behind leading global flags", () => {
	test("`--approval-mode=yolo acp` dispatches the acp subcommand with the flag preserved", () => {
		expect(resolveCliArgv(["--approval-mode=yolo", "acp"])).toEqual({
			argv: ["acp", "--approval-mode=yolo"],
		});
	});

	test("space-form `--approval-mode yolo acp` keeps the flag and its value with acp", () => {
		expect(resolveCliArgv(["--approval-mode", "yolo", "acp"])).toEqual({
			argv: ["acp", "--approval-mode", "yolo"],
		});
	});

	test("multiple leading flags before the subcommand are all preserved", () => {
		expect(resolveCliArgv(["--approval-mode=yolo", "--model", "gpt", "acp"])).toEqual({
			argv: ["acp", "--approval-mode=yolo", "--model", "gpt"],
		});
	});

	test("a value-consuming flag does not mistake its value for a subcommand", () => {
		// `acp` here is the value of `--model`, not the subcommand, so this stays a
		// launch prompt exactly as the launch parser would read it.
		expect(resolveCliArgv(["--model", "acp"])).toEqual({
			argv: ["launch", "--model", "acp"],
		});
	});

	test("`--` ends option scanning so a following subcommand stays a launch prompt", () => {
		expect(resolveCliArgv(["--", "acp"])).toEqual({
			argv: ["launch", "--", "acp"],
		});
	});

	test("a genuine launch prompt is untouched", () => {
		expect(resolveCliArgv(["--approval-mode=yolo", "fix", "the", "bug"])).toEqual({
			argv: ["launch", "--approval-mode=yolo", "fix", "the", "bug"],
		});
	});

	test("a subcommand already in front still passes through unchanged", () => {
		expect(resolveCliArgv(["acp", "--approval-mode=yolo"])).toEqual({
			argv: ["acp", "--approval-mode=yolo"],
		});
	});

	test("`gc` dispatches as a top-level maintenance subcommand", () => {
		expect(resolveCliArgv(["gc", "--apply"])).toEqual({
			argv: ["gc", "--apply"],
		});
	});
});

describe("resolveCliArgv strips launch-global flags before non-launch subcommands (#8891)", () => {
	test("`--cwd <dir> update` drops the inapplicable launch flag instead of forwarding it", () => {
		// Forwarding `--cwd` into update's strict parser crashed with
		// `Unknown option '--cwd'`; the launch-only flag is now dropped.
		expect(resolveCliArgv(["--cwd", "/tmp", "update"])).toEqual({ argv: ["update"] });
	});

	test("`--cwd=<dir>` inline form is stripped too", () => {
		expect(resolveCliArgv(["--cwd=/tmp", "update"])).toEqual({ argv: ["update"] });
	});

	test("a trailing subcommand flag survives while the leading launch flag is stripped", () => {
		expect(resolveCliArgv(["--cwd", "/tmp", "update", "--force"])).toEqual({
			argv: ["update", "--force"],
		});
	});

	test("multiple leading launch flags are all stripped before a non-launch subcommand", () => {
		expect(resolveCliArgv(["--model", "gpt", "--cwd", "/x", "update"])).toEqual({ argv: ["update"] });
	});

	test("a subcommand's own flag placed before it is kept, not treated as launch-global", () => {
		expect(resolveCliArgv(["-c", "update"])).toEqual({ argv: ["update", "-c"] });
	});

	test("launch-shaped `acp` still receives forwarded launch-global flags", () => {
		expect(resolveCliArgv(["--cwd", "/x", "acp"])).toEqual({ argv: ["acp", "--cwd", "/x"] });
	});
});
