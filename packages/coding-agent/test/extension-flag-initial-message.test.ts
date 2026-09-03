import { describe, expect, it } from "bun:test";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { applyExtensionFlags, type ExtensionFlagSink } from "@oh-my-pi/pi-coding-agent/cli/extension-flags";
import { buildInitialMessage } from "@oh-my-pi/pi-coding-agent/cli/initial-message";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { normalizeContinueSessionArgs } from "@oh-my-pi/pi-coding-agent/main";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

// Regression coverage for extension-registered flags leaking into the initial
// prompt. The CLI parses argv twice: once at startup (before extensions load,
// so their flag set is unknown) and once after the extension runner is ready.
// `buildInitialMessage` must run on the second, extension-aware parse.
describe("extension flags vs initial message", () => {
	const extFlags = new Map<string, { type: "boolean" | "string" }>([
		["spawn-peer", { type: "string" }],
		["headless", { type: "boolean" }],
	]);

	it("consumes a string extension flag's value instead of leaking it into messages", () => {
		const parsed = parseArgs(["--spawn-peer", "reviewer", "review the diff"], extFlags);

		expect(parsed.unknownFlags.get("spawn-peer")).toBe("reviewer");
		expect(parsed.messages).toEqual(["review the diff"]);
	});

	it("consumes a boolean extension flag without eating the following message", () => {
		const parsed = parseArgs(["--headless", "do the task"], extFlags);

		expect(parsed.unknownFlags.get("headless")).toBe(true);
		expect(parsed.messages).toEqual(["do the task"]);
	});
	it("drops a boolean extension flag's value in equals form (no leak into messages)", () => {
		const parsed = parseArgs(["--headless=true", "do the task"], extFlags);
		expect(parsed.unknownFlags.get("headless")).toBe(true);
		expect(parsed.messages).toEqual(["do the task"]);
	});
	it("drops a built-in boolean flag's value in equals form too", () => {
		const parsed = parseArgs(["--no-tools=true", "do the task"]);
		expect(parsed.noTools).toBe(true);
		expect(parsed.messages).toEqual(["do the task"]);
	});
	it("does not consume a flag-looking string value in space form, keeping command shape (P1#2)", () => {
		// `--print` after an extension flag (unknown at startup) must stay the
		// built-in print flag in BOTH parses, so the reparse cannot silently flip
		// command behavior. Flag-looking values must be passed as `--flag=value`.
		const parsed = parseArgs(["--spawn-peer", "--print", "hello"], extFlags);
		expect(parsed.unknownFlags.has("spawn-peer")).toBe(false);
		expect(parsed.print).toBe(true);
		expect(parsed.messages).toEqual(["hello"]);
	});
	it("consumes a flag-looking string value in equals form", () => {
		const parsed = parseArgs(["--spawn-peer=--print", "hello"], extFlags);
		expect(parsed.unknownFlags.get("spawn-peer")).toBe("--print");
		expect(parsed.print).toBeUndefined();
		expect(parsed.messages).toEqual(["hello"]);
	});
	it("keeps standalone -- as end-of-options after a string extension flag", () => {
		const parsed = parseArgs(["--spawn-peer", "--", "--model", "opus", "hello"], extFlags);
		expect(parsed.unknownFlags.has("spawn-peer")).toBe(false);
		expect(parsed.model).toBeUndefined();
		expect(parsed.messages).toEqual(["--model", "opus", "hello"]);
	});
	it("consumes literal -- string values only in equals form", () => {
		const parsed = parseArgs(["--spawn-peer=--", "--model", "opus", "hello"], extFlags);
		expect(parsed.unknownFlags.get("spawn-peer")).toBe("--");
		expect(parsed.model).toBe("opus");
		expect(parsed.messages).toEqual(["hello"]);
	});
	it("treats an @-prefixed string value as the flag's value, not a file arg (P1#1)", () => {
		const parsed = parseArgs(["--spawn-peer", "@notes.md", "hello"], extFlags);
		expect(parsed.unknownFlags.get("spawn-peer")).toBe("@notes.md");
		expect(parsed.fileArgs).toEqual([]);
		expect(parsed.messages).toEqual(["hello"]);
	});
	it("documents the P1#1 startup-parse leak: without flags, an @-value is misread as a file arg", () => {
		// This is the startup parse (extensions not loaded). `runRootCommand` must
		// run processFileArguments on the extension-aware parse, not this one, or
		// `@notes.md` gets read into the prompt as a file.
		const parsed = parseArgs(["--spawn-peer", "@notes.md", "hello"]);
		expect(parsed.fileArgs).toEqual(["notes.md"]);
	});
	it("lets a registered flag shadow a same-named built-in instead of consuming the next token (bot P2)", () => {
		// A boolean extension flag colliding with the value-taking built-in --plan
		// must be parsed as the extension's boolean, NOT the built-in plan-model
		// selector — otherwise it eats the following message and corrupts result.plan.
		const planFlags = new Map<string, { type: "boolean" | "string" }>([["plan", { type: "boolean" }]]);
		const parsed = parseArgs(["--plan", "review the diff"], planFlags);
		expect(parsed.unknownFlags.get("plan")).toBe(true);
		expect(parsed.plan).toBeUndefined();
		expect(parsed.messages).toEqual(["review the diff"]);
	});

	it("builds the initial prompt from the real message, not the flag value, when flags are known", () => {
		const parsed = parseArgs(["--spawn-peer", "reviewer", "review the diff"], extFlags);

		const { initialMessage } = buildInitialMessage({ parsed, stdinContent: "diff-context" });

		expect(initialMessage).toBe("diff-context\nreview the diff");
	});

	it("keeps a continued session id out of the prompt after extension-aware reparse", () => {
		const sessionId = "019ea530-ffff-7000-8000-000000000000";
		const sink: ExtensionFlagSink = {
			getFlags: () => extFlags,
			setFlagValue: () => {},
		};
		const parsed = applyExtensionFlags(sink, ["--continue", sessionId]);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		normalizeContinueSessionArgs(parsed);
		const { initialMessage } = buildInitialMessage({ parsed });

		expect(parsed.resume).toBe(sessionId);
		expect(parsed.continue).toBe(false);
		expect(parsed.messages).toEqual([]);
		expect(initialMessage).toBeUndefined();
	});

	it("removes a continued session id while preserving a following prompt after extension reparse", () => {
		const sessionId = "019ea530-ffff-7000-8000-000000000000";
		const rawArgs = ["--continue", sessionId, "--spawn-peer", "reviewer", "do next"];
		const sink: ExtensionFlagSink = {
			getFlags: () => extFlags,
			setFlagValue: () => {},
		};
		const parsed = applyExtensionFlags(sink, rawArgs);
		expect(parsed).not.toBeNull();
		if (!parsed) return;

		normalizeContinueSessionArgs(parsed, rawArgs);

		expect(parsed.resume).toBe(sessionId);
		expect(parsed.messages).toEqual(["do next"]);
	});

	it("does not consume a UUID-shaped extension flag value before extension-aware reparse", () => {
		const sessionId = "019ea530-ffff-7000-8000-000000000000";
		const rawArgs = ["--continue", "--spawn-peer", sessionId];
		const startupArgs = parseArgs(rawArgs);

		normalizeContinueSessionArgs(startupArgs);
		expect(startupArgs.continue).toBe(true);
		expect(startupArgs.resume).toBeUndefined();
		expect(startupArgs.messages).toEqual([sessionId]);

		const sink: ExtensionFlagSink = {
			getFlags: () => extFlags,
			setFlagValue: () => {},
		};
		const extensionArgs = applyExtensionFlags(sink, rawArgs);
		expect(extensionArgs).not.toBeNull();
		if (!extensionArgs) return;

		normalizeContinueSessionArgs(extensionArgs);
		expect(extensionArgs.continue).toBe(true);
		expect(extensionArgs.resume).toBeUndefined();
		expect(extensionArgs.messages).toEqual([]);
	});

	it("resolves a continued session id before a later extension flag is known", () => {
		const sessionId = "019ea530-ffff-7000-8000-000000000000";
		const rawArgs = ["--continue", sessionId, "--spawn-peer", "reviewer"];
		const startupArgs = parseArgs(rawArgs);

		normalizeContinueSessionArgs(startupArgs, rawArgs);

		expect(startupArgs.continue).toBe(false);
		expect(startupArgs.resume).toBe(sessionId);
		expect(startupArgs.messages).toEqual(["reviewer"]);
	});

	it("documents the pre-fix leak: without the flag map the value becomes the first prompt", () => {
		// This is exactly the startup parse: extensions have not loaded, so the
		// flag map is absent. `--spawn-peer` is dropped (it starts with `-`) but
		// its bare value `reviewer` is mis-read as the first positional message.
		// Re-parsing with the extension flag map is what corrects this.
		const parsed = parseArgs(["--spawn-peer", "reviewer", "review the diff"]);

		expect(parsed.messages).toEqual(["reviewer", "review the diff"]);

		const { initialMessage } = buildInitialMessage({ parsed, stdinContent: "diff-context" });
		expect(initialMessage).toBe("diff-context\nreviewer");
	});
	it("does not mutate the input argv, so the same array survives the two-pass parse (PR #1503 review)", () => {
		// Reproduces the --option=value + extension flag combo: parseArgs splices
		// the `=` value into its argv to reuse the `args[++i]` path. If it mutated
		// the caller's array, the second (extension-aware) parse would re-splice
		// and `sonnet` would leak into the prompt before "review the diff".
		const argv = ["--model=sonnet", "--spawn-peer", "reviewer", "review the diff"];
		const snapshot = [...argv];
		// First pass: startup parse, before extensions load.
		parseArgs(argv);
		expect(argv).toEqual(snapshot);
		// Second pass: extension-aware reparse on the same array.
		const reparsed = parseArgs(argv, extFlags);
		expect(reparsed.model).toBe("sonnet");
		expect(reparsed.unknownFlags.get("spawn-peer")).toBe("reviewer");
		expect(reparsed.messages).toEqual(["review the diff"]);
		expect(argv).toEqual(snapshot);
	});
});

describe("applyExtensionFlags (single-parser flag resolution)", () => {
	function fakeRunner(
		flags: Record<string, "boolean" | "string">,
	): ExtensionFlagSink & { values: Map<string, boolean | string> } {
		const flagMap = new Map(
			Object.entries(flags).map(([name, type]) => [name, { type }] as [string, { type: "boolean" | "string" }]),
		);
		const values = new Map<string, boolean | string>();
		return {
			values,
			getFlags: () => flagMap,
			setFlagValue: (name, value) => {
				values.set(name, value);
			},
		};
	}
	it("returns null when there is no runner", () => {
		expect(applyExtensionFlags(undefined, ["--spawn-peer", "x", "task"])).toBeNull();
	});
	it("reparses with an empty extension registry so unknown flags remain visible", () => {
		expect(applyExtensionFlags(fakeRunner({}), ["--whatever", "task"])?.unrecognizedFlags).toEqual(["--whatever"]);
	});
	it("applies and strips a string flag in space form", () => {
		const runner = fakeRunner({ "spawn-peer": "string" });
		const args = applyExtensionFlags(runner, ["--spawn-peer", "reviewer", "review the diff"]);
		expect(runner.values.get("spawn-peer")).toBe("reviewer");
		expect(args?.messages).toEqual(["review the diff"]);
	});
	it("applies and strips a string flag in equals form (regression for r3323133381)", () => {
		const runner = fakeRunner({ "spawn-peer": "string" });
		const args = applyExtensionFlags(runner, ["--spawn-peer=reviewer", "review the diff"]);
		expect(runner.values.get("spawn-peer")).toBe("reviewer");
		expect(args?.messages).toEqual(["review the diff"]);
	});
	it("applies a boolean flag without consuming the following message", () => {
		const runner = fakeRunner({ headless: "boolean" });
		const args = applyExtensionFlags(runner, ["--headless", "do the task"]);
		expect(runner.values.get("headless")).toBe(true);
		expect(args?.messages).toEqual(["do the task"]);
	});
	it("drops a boolean flag's value in equals form (regression for r3323200058)", () => {
		const runner = fakeRunner({ headless: "boolean" });
		const args = applyExtensionFlags(runner, ["--headless=true", "do the task"]);
		expect(runner.values.get("headless")).toBe(true);
		expect(args?.messages).toEqual(["do the task"]);
	});
	it("re-parses whenever flags are registered, even if none were passed (gate = registered presence)", () => {
		const runner = fakeRunner({ "spawn-peer": "string" });
		const args = applyExtensionFlags(runner, ["just a prompt"]);
		expect(args?.messages).toEqual(["just a prompt"]);
		expect(runner.values.size).toBe(0);
	});
	it("preserves the message and built-in field for a built-in-colliding boolean flag (plan-mode --plan)", () => {
		// Bot P2: a colliding boolean flag must not let the built-in --plan (string)
		// branch eat the prompt or set the plan-model field. The extension flag
		// shadows the built-in, so plan=true is delivered AND the message survives.
		const runner = fakeRunner({ plan: "boolean" });
		const args = applyExtensionFlags(runner, ["--plan", "review the diff"]);
		expect(runner.values.get("plan")).toBe(true);
		expect(args?.messages).toEqual(["review the diff"]);
		expect(args?.plan).toBeUndefined();
	});
	it("does not deliver a colliding flag that was not passed", () => {
		const runner = fakeRunner({ plan: "boolean" });
		const args = applyExtensionFlags(runner, ["just a prompt"]);
		expect(runner.values.has("plan")).toBe(false);
		expect(args?.messages).toEqual(["just a prompt"]);
	});
	it("shadows a colliding string built-in flag, delivering its value and keeping the message (--model)", () => {
		// `--model` is a built-in string flag; the registered extension flag shadows
		// it so the value reaches unknownFlags and the trailing message is preserved,
		// without consulting any list of built-in names.
		const runner = fakeRunner({ model: "string" });
		const args = applyExtensionFlags(runner, ["--model", "haiku", "do the task"]);
		expect(runner.values.get("model")).toBe("haiku");
		expect(args?.messages).toEqual(["do the task"]);
		expect(args?.model).toBeUndefined();
	});
	it("does not consume a non-colliding flag-looking value in space form (mirrors parseArgs P1#2)", () => {
		// A flag-looking value in space form stays its own flag in both passes, so
		// it must not be swallowed as the extension flag's value (use --flag=value).
		const runner = fakeRunner({ "spawn-peer": "string" });
		const args = applyExtensionFlags(runner, ["--spawn-peer", "--print", "do the task"]);
		expect(runner.values.has("spawn-peer")).toBe(false);
		expect(args?.print).toBe(true);
		expect(args?.messages).toEqual(["do the task"]);
	});
});
describe("registerFlag with built-in-named flags (r3323473227)", () => {
	it("loads an extension that registers a built-in-named flag without throwing", async () => {
		const ext = await loadExtensionFromFactory(
			api => {
				api.registerFlag("plan", { type: "boolean", default: false });
			},
			process.cwd(),
			new EventBus(),
			new ExtensionRuntime(),
		);
		expect(ext.flags.has("plan")).toBe(true);
	});
	it("loads a non-colliding extension flag", async () => {
		const ext = await loadExtensionFromFactory(
			api => {
				api.registerFlag("spawn-peer", { type: "string" });
			},
			process.cwd(),
			new EventBus(),
			new ExtensionRuntime(),
		);
		expect(ext.flags.has("spawn-peer")).toBe(true);
	});
	it("resolves extension flags from a pre-session load (main.ts @file-before-session pattern)", async () => {
		// main.ts now loads extensions and resolves their flags BEFORE creating the
		// session (and its breadcrumb), building an ExtensionFlagSink straight from
		// the loaded extensions + runtime with no ExtensionRunner/session yet. Prove
		// that exact pattern resolves flag values and classifies `@file` args
		// extension-aware — the reason file processing can safely run pre-session.
		const runtime = new ExtensionRuntime();
		const ext = await loadExtensionFromFactory(
			api => {
				api.registerFlag("spawn-peer", { type: "string" });
			},
			process.cwd(),
			new EventBus(),
			runtime,
		);
		const sink: ExtensionFlagSink = {
			getFlags: () => ExtensionRunner.aggregateFlags([ext]),
			setFlagValue: (name, value) => {
				runtime.flagValues.set(name, value);
			},
		};

		const args = applyExtensionFlags(sink, ["--spawn-peer", "reviewer", "review the diff"]);
		expect(runtime.flagValues.get("spawn-peer")).toBe("reviewer");
		expect(args?.messages).toEqual(["review the diff"]);

		// A string flag's `@`-value is the flag's value, not a file arg (P1#1) — so
		// classifying it requires this extension-aware parse, which is only possible
		// once the flag set is known before the session exists.
		const withFileLikeValue = applyExtensionFlags(sink, ["--spawn-peer", "@notes.md", "hello"]);
		expect(runtime.flagValues.get("spawn-peer")).toBe("@notes.md");
		expect(withFileLikeValue?.fileArgs).toEqual([]);
		expect(withFileLikeValue?.messages).toEqual(["hello"]);
	});
});
