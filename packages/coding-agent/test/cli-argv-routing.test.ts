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
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { resolveCliArgv } from "@oh-my-pi/pi-coding-agent/cli-commands";
import { parseReviewLaunch, reviewFocus, validateReviewLaunch } from "@oh-my-pi/pi-coding-agent/commands/review";

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

	test("routes the review subcommand without launch-flag rewriting", () => {
		expect(resolveCliArgv(["review", "--base", "main", "commit", "handling"])).toEqual({
			argv: ["review", "--base", "main", "commit", "handling"],
		});
	});

	test("forwards launch flags before the review subcommand", () => {
		expect(resolveCliArgv(["--model", "anthropic/opus", "--max-time", "600", "review", "--base", "main"])).toEqual({
			argv: ["review", "--model", "anthropic/opus", "--max-time", "600", "--base", "main"],
		});
	});

	test("keeps forwarded launch flags and forces the headless review contract", () => {
		const review = parseReviewLaunch([
			"--model",
			"anthropic/opus",
			"--max-time",
			"600",
			"--base",
			"main",
			"--head",
			"HEAD",
			"focus",
		]);
		expect(review).toEqual({
			base: "main",
			head: "HEAD",
			launchArgv: [
				"--print",
				"--allow-home",
				"--wait-async",
				"--model",
				"anthropic/opus",
				"--max-time",
				"600",
				"focus",
			],
		});
		expect(parseArgs(review.launchArgv).waitAsync).toBe(true);
	});

	test("rejects an explicitly empty or missing review head", () => {
		expect(() => parseReviewLaunch(["--base", "main", "--head"])).toThrow("--head requires a non-empty ref.");
		expect(() => parseReviewLaunch(["--base", "main", "--head="])).toThrow("--head requires a non-empty ref.");
		expect(() => parseReviewLaunch(["--base", "main", "--head", "HEAD", "--head"])).toThrow(
			"--head requires a non-empty ref.",
		);
		expect(() => parseReviewLaunch(["--base", "main", "--head", "--head", "HEAD"])).toThrow(
			"--head requires a non-empty ref.",
		);
		expect(() => parseReviewLaunch(["--base", "--base", "main"])).toThrow("--base requires a non-empty ref.");
		expect(() => parseReviewLaunch(["--base=", "--base", "main"])).toThrow("--base requires a non-empty ref.");
	});

	test("rejects unsupported launch flags even when their value is missing", () => {
		for (const argv of [
			["--base", "main", "--fork"],
			["--base", "main", "--export"],
			["--base", "main", "--goal"],
			["--base", "main", "--no-ui"],
		]) {
			expect(() => parseReviewLaunch(argv)).toThrow("omp review");
		}
	});

	test("keeps flag-like values of supported string launch flags", () => {
		const review = parseReviewLaunch(["--base", "main", "--system-prompt", "--fork", "focus"]);
		const parsed = parseArgs(review.launchArgv);

		expect(parsed.systemPrompt).toBe("--fork");
		expect(parsed.messages).toEqual(["focus"]);
	});

	test("keeps option-looking focus text after the separator", () => {
		const review = parseReviewLaunch(["--base", "main", "--", "check the --head flag"]);
		expect(review).toEqual({
			base: "main",
			launchArgv: ["--print", "--allow-home", "--wait-async", "--", "check the --head flag"],
		});
		expect(parseArgs(review.launchArgv).messages).toEqual(["check the --head flag"]);
	});

	test("preserves focus after an extension-owned boolean flag", () => {
		const review = parseReviewLaunch(["-e", "plan-mode.ts", "--base", "main", "--plan", "inspect", "auth"]);

		const parsed = parseArgs(review.launchArgv, new Map([["plan", { type: "boolean" as const }]]));
		expect(parsed.messages).toEqual(["inspect", "auth"]);
	});

	test("retains an @-prefixed focus token as text", () => {
		const review = parseReviewLaunch(["--base", "main", "@src/auth.ts"]);
		const parsed = parseArgs(review.launchArgv);

		expect(parsed.messages).toEqual([]);
		expect(parsed.fileArgs).toEqual(["src/auth.ts"]);
		expect(reviewFocus(parsed)).toBe("@src/auth.ts");
	});

	test("rejects launch selectors that restore or import a session", () => {
		for (const argv of [
			["--continue"],
			["--resume", "session-id"],
			["--restore", "session-id"],
			["--fork", "session-id"],
			["--from-claude"],
			["--from-codex"],
		]) {
			expect(() => validateReviewLaunch(parseArgs(argv))).toThrow("omp review starts a fresh session");
		}
	});

	test("rejects launch modes that bypass the review runner", () => {
		for (const argv of [
			["--mode", "acp"],
			["--mode", "rpc"],
			["--mode", "rpc-ui"],
			["--export", "out.html"],
			["--goal", "ship it"],
			["--no-ui"],
		]) {
			expect(() => validateReviewLaunch(parseArgs(argv))).toThrow("omp review does not support");
		}
	});

	test("rejects tool restrictions that omit the reviewer task tool", () => {
		expect(() => validateReviewLaunch(parseArgs(["--no-tools"]))).toThrow("omp review requires the task tool");
		expect(() => validateReviewLaunch(parseArgs(["--tools", "read"]))).toThrow("omp review requires the task tool");
		expect(() => validateReviewLaunch(parseArgs(["--no-tools", "--tools", "task"]))).toThrow(
			"omp review requires the task tool",
		);
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

	test("extension-shadowable `--plan` before another flag does not hide a trailing subcommand", () => {
		expect(resolveCliArgv(["--plan", "--cwd", "/tmp", "update"])).toEqual({ argv: ["update"] });
		const acpResolved = resolveCliArgv(["--plan", "--model", "opus", "acp"]);
		expect(acpResolved).toEqual({ argv: ["acp", "--plan", "--model", "opus"] });
		if ("argv" in acpResolved) {
			expect(parseArgs(acpResolved.argv.slice(1)).model).toBe("opus");
		}
		expect(resolveCliArgv(["--plan", "acp"])).toEqual({ argv: ["launch", "--plan", "acp"] });
	});
});
