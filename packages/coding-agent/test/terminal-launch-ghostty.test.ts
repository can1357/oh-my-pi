import { describe, expect, it } from "bun:test";
import {
	createDefaultTerminalLaunchRequest,
	createTerminalLauncher,
	getTerminalLaunchPlacement,
	type TerminalLaunchCliResult,
	type TerminalLaunchCliRunner,
	TerminalLaunchError,
	type TerminalLaunchRequest,
} from "../src/subprocess/terminal-launch";

interface CliCall {
	argv: string[];
	cwd: string;
	env?: NodeJS.ProcessEnv;
}

function createHarness(
	env: NodeJS.ProcessEnv,
	responses: TerminalLaunchCliResult[],
	platform: NodeJS.Platform = "darwin",
) {
	const calls: CliCall[] = [];
	const runCli: TerminalLaunchCliRunner = async (argv, cwd, env) => {
		calls.push({ argv: [...argv], cwd, env });
		const response = responses.shift();
		if (!response) throw new Error("unexpected CLI call");
		return response;
	};
	const launch = createTerminalLauncher({ environment: () => env, platform, runCli });
	return { calls, launch };
}

type AssertTrue<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;
type IsAssignable<Source, Target> = [Source] extends [Target] ? true : false;

type GhosttyPaneOptionsAreSupported = AssertTrue<
	IsAssignable<
		{
			multiplexer: "ghostty";
			placement: "pane";
			command: readonly string[];
			cwd: string;
			shellGrammar: "posix";
			direction: "left";
			focus: false;
		},
		TerminalLaunchRequest
	>
>;
type GhosttyPaneShellGrammarIsRequired = AssertFalse<
	IsAssignable<
		{ multiplexer: "ghostty"; placement: "pane"; command: readonly string[]; cwd: string },
		TerminalLaunchRequest
	>
>;
type GhosttyWindowTargetIsExcluded = AssertFalse<
	IsAssignable<
		{
			multiplexer: "ghostty";
			placement: "window";
			command: readonly string[];
			cwd: string;
			shellGrammar: "posix";
			target: string;
		},
		TerminalLaunchRequest
	>
>;
type GhosttyWindowDirectionIsExcluded = AssertFalse<
	IsAssignable<
		{
			multiplexer: "ghostty";
			placement: "window";
			command: readonly string[];
			cwd: string;
			shellGrammar: "posix";
			direction: "right";
		},
		TerminalLaunchRequest
	>
>;
const ghosttyTypeChecks: [
	GhosttyPaneOptionsAreSupported,
	GhosttyPaneShellGrammarIsRequired,
	GhosttyWindowTargetIsExcluded,
	GhosttyWindowDirectionIsExcluded,
] = [true, false, false, false];
void ghosttyTypeChecks;

const GHOSTTY_ENV: NodeJS.ProcessEnv = { TERM_PROGRAM: "ghostty" };
const VERSION_OK: TerminalLaunchCliResult = { stdout: "1.4.0\n", exitCode: 0 };

/** A process table whose chain is this process → its parent shell → init. */
function processTable(ownTty = "ttys003"): TerminalLaunchCliResult {
	const stdout = [
		"  1     0 ttys000",
		`  ${process.ppid}     1 ${ownTty}`,
		`  ${process.pid}     ${process.ppid} ${ownTty}`,
		"",
	].join("\n");
	return { stdout, exitCode: 0 };
}

function terminalList(rows: string[]): TerminalLaunchCliResult {
	return { stdout: `${rows.join("\n")}\n`, exitCode: 0 };
}

function paneRequest(extra: Record<string, unknown> = {}): TerminalLaunchRequest {
	return {
		multiplexer: "ghostty",
		placement: "pane",
		command: ["omp", "--fork", "/repo/session.jsonl"],
		cwd: "/repo",
		shellGrammar: "posix",
		...extra,
	} as TerminalLaunchRequest;
}

describe("Ghostty launch construction", () => {
	it("reports Ghostty placement metadata and requires the shell-grammar assertion", () => {
		expect(getTerminalLaunchPlacement("ghostty", "pane")).toEqual({
			multiplexer: "ghostty",
			displayName: "Ghostty",
			placementLabel: "pane",
			shellGrammar: "posix",
		});
		expect(getTerminalLaunchPlacement("ghostty", "window")).toEqual({
			multiplexer: "ghostty",
			displayName: "Ghostty",
			placementLabel: "tab",
			shellGrammar: "posix",
		});

		const unconfirmed = createDefaultTerminalLaunchRequest("ghostty", "pane", ["omp"], "/repo");
		if (!("error" in unconfirmed)) throw new Error("shell-input request unexpectedly omitted its grammar error");
		expect(unconfirmed.error).toContain('requires shellGrammar: "posix"');

		const confirmed = createDefaultTerminalLaunchRequest("ghostty", "window", ["omp"], "/repo", "posix");
		if ("error" in confirmed) throw new Error(confirmed.error);
		expect(confirmed.request.multiplexer).toBe("ghostty");
	});
});

describe("Ghostty launches", () => {
	it("splits the host terminal resolved from process ancestry", async () => {
		const { calls, launch } = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList([`term-other|424242|/dev/ttys004|win-1`, `term-host|${process.ppid}|/dev/ttys003|win-1`]),
			{ stdout: "OK|term-new\n", exitCode: 0 },
		]);
		const result = await launch(paneRequest());
		expect(result).toEqual({ multiplexer: "ghostty", placement: "pane", id: "term-new" });
		expect(calls.map(call => call.argv[0])).toEqual(["osascript", "ps", "osascript", "osascript"]);
		expect(calls[2]!.argv[2]).toContain("terminals of w");
		const script = calls[3]!.argv[2]!;
		expect(script).toContain('"win-1"');
		expect(script).toContain('"term-host"');
		expect(script).toContain("split hostTerm direction right with configuration cfg");
		// The command rides as initial input (`exec …` into the default shell),
		// never as the configuration `command` property: Ghostty forces
		// wait-after-command on for configured commands, which would leave the
		// split open on "Process exited" after the fork child exits.
		expect(script).toContain("set forkInput to \"exec \" & \"'omp' '--fork' '/repo/session.jsonl'\" & return");
		expect(script).toContain("initial input:forkInput");
		expect(script).not.toContain("wait after command");
		expect(script).toContain('initial working directory:"/repo"');
	});

	it("ignores surfaces without a live process when listing terminals", async () => {
		const { calls, launch } = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList([
				`term-dead|0|/dev/ttys010|win-leftover`,
				`term-idle|missing value|/dev/ttys011|win-1`,
				`term-host|${process.ppid}|/dev/ttys003|win-1`,
			]),
			{ stdout: "OK|term-new\n", exitCode: 0 },
		]);
		const result = await launch(paneRequest());
		expect(result).toEqual({ multiplexer: "ghostty", placement: "pane", id: "term-new" });
		const script = calls[3]!.argv[2]!;
		expect(script).toContain('"term-host"');
		expect(script).not.toContain('"term-dead"');
	});

	it("opens a tab in the hosting window and restores focus to the host when focus is false", async () => {
		const { calls, launch } = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList([`term-host|${process.ppid}|/dev/ttys003|win-7`]),
			{ stdout: "OK|term-tab\n", exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "ghostty",
			placement: "window",
			command: ["omp", "--fork", "/repo/session.jsonl"],
			cwd: "/repo",
			shellGrammar: "posix",
			focus: false,
		});
		expect(result).toEqual({ multiplexer: "ghostty", placement: "window", id: "term-tab" });
		const script = calls[3]!.argv[2]!;
		expect(script).toContain("new tab in hostWindow with configuration cfg");
		// The branch must compile: a bare `else` cannot follow a one-line `then`.
		expect(script).toContain(
			"if class of created is tab then\n\t\tset newTerm to first terminal of created\n\telse\n\t\tset newTerm to created\n\tend if",
		);
		expect(script).toContain("focus hostTerm");
		expect(script).not.toContain("focus newTerm");
	});

	it("honors an explicit split direction and focuses the new terminal when focus is true", async () => {
		const { calls, launch } = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList([`term-host|${process.ppid}|/dev/ttys003|win-1`]),
			{ stdout: "OK|term-down\n", exitCode: 0 },
		]);
		await launch(paneRequest({ direction: "down", focus: true }));
		const script = calls[3]!.argv[2]!;
		expect(script).toContain("split hostTerm direction down with configuration cfg");
		expect(script).toContain("focus newTerm");
	});

	it("escapes command and cwd values into AppleScript string literals", async () => {
		const { calls, launch } = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList([`term-host|${process.ppid}|/dev/ttys003|win-1`]),
			{ stdout: "OK|term-quoted\n", exitCode: 0 },
		]);
		await launch(
			paneRequest({
				command: ["omp", "--fork", '/repo/we"ird dir/session.jsonl'],
				cwd: '/repo/we"ird dir',
			}),
		);
		const script = calls[3]!.argv[2]!;
		// POSIX quoting protects the shell; backslash-escaping protects the AppleScript literal.
		expect(script).toContain('initial working directory:"/repo/we\\"ird dir"');
		expect(script).toContain('we\\"ird');
	});

	it("falls back to the controlling tty when no ancestor is hosted", async () => {
		const { calls, launch } = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList(["term-tty|424243|/dev/ttys003|win-3", "term-other|424244|/dev/ttys009|win-3"]),
			{ stdout: "OK|term-new\n", exitCode: 0 },
		]);
		const result = await launch(paneRequest());
		expect(result.id).toBe("term-new");
		expect(calls[3]!.argv[2]).toContain('"term-tty"');
	});

	it("rejects non-macOS platforms and missing Ghostty sessions before any CLI call", async () => {
		const linux = createHarness(GHOSTTY_ENV, [], "linux");
		await expect(linux.launch(paneRequest())).rejects.toThrow("only supported on macOS");
		expect(linux.calls).toEqual([]);

		const noSession = createHarness({ TERM_PROGRAM: "iTerm.app" }, []);
		await expect(noSession.launch(paneRequest())).rejects.toThrow("requires an active Ghostty terminal");
		expect(noSession.calls).toEqual([]);
	});

	it("requires Ghostty 1.4.0 or newer, naming the update when older or undetermined", async () => {
		const old = createHarness(GHOSTTY_ENV, [{ stdout: "1.3.1\n", exitCode: 0 }]);
		await expect(old.launch(paneRequest())).rejects.toThrow("require Ghostty 1.4.0 or newer");
		await expect(old.launch(paneRequest())).rejects.toThrow(TerminalLaunchError);

		const unknown = createHarness(GHOSTTY_ENV, [{ stdout: "not a version\n", exitCode: 0 }]);
		await expect(unknown.launch(paneRequest())).rejects.toThrow("could not be determined");
	});

	it("fails when no Ghostty terminal hosts this process", async () => {
		const empty = createHarness(GHOSTTY_ENV, [VERSION_OK, processTable(), terminalList([])]);
		await expect(empty.launch(paneRequest())).rejects.toThrow("could not find the terminal hosting this process");

		const noMatch = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable("??"),
			terminalList(["term-other|424245|/dev/ttys004|win-1"]),
		]);
		await expect(noMatch.launch(paneRequest())).rejects.toThrow("could not find the terminal hosting this process");
	});

	it("maps AppleScript errors to their documented meanings", async () => {
		const denied = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList([`term-host|${process.ppid}|/dev/ttys003|win-1`]),
			{ stdout: "ERR|-1743|Not authorized to send Apple events\n", exitCode: 0 },
		]);
		await expect(denied.launch(paneRequest())).rejects.toThrow("Automation permission");

		const noHost = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList([`term-host|${process.ppid}|/dev/ttys003|win-1`]),
			{ stdout: "ERR|-2700|Cannot find the terminal\n", exitCode: 0 },
		]);
		await expect(noHost.launch(paneRequest())).rejects.toThrow("could not find the terminal hosting this process");

		const other = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList([`term-host|${process.ppid}|/dev/ttys003|win-1`]),
			{ stdout: "ERR|-2740|AppleScript syntax error\n", exitCode: 0 },
		]);
		await expect(other.launch(paneRequest())).rejects.toThrow("AppleScript error -2740");
	});

	it("maps a denied Automation permission at the version check and the terminal listing", async () => {
		// Regression: the version check is the first AppleScript call, and it
		// used to run without the try/on-error envelope, so a denial surfaced
		// as a bare "ghostty version failed (exit 1)" with no guidance.
		const deniedVersion = createHarness(GHOSTTY_ENV, [
			{ stdout: "ERR|-1743|Not authorized to send Apple events\n", exitCode: 0 },
		]);
		await expect(deniedVersion.launch(paneRequest())).rejects.toThrow("Automation permission");
		expect(deniedVersion.calls).toHaveLength(1);
		// The denial can only be reported because the script itself is wrapped.
		expect(deniedVersion.calls[0]!.argv[2]).toContain('return "ERR|" & errNumber & "|" & errMessage');

		const deniedList = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			{ stdout: "ERR|-1743|Not authorized to send Apple events\n", exitCode: 0 },
		]);
		await expect(deniedList.launch(paneRequest())).rejects.toThrow("Automation permission");
	});

	it("fails on a nonzero osascript exit or an unexpected placement response", async () => {
		const exited = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList([`term-host|${process.ppid}|/dev/ttys003|win-1`]),
			{ stdout: "", exitCode: 1 },
		]);
		await expect(exited.launch(paneRequest())).rejects.toThrow("failed (exit 1)");

		const garbage = createHarness(GHOSTTY_ENV, [
			VERSION_OK,
			processTable(),
			terminalList([`term-host|${process.ppid}|/dev/ttys003|win-1`]),
			{ stdout: "what was that\n", exitCode: 0 },
		]);
		await expect(garbage.launch(paneRequest())).rejects.toThrow("unexpected response");
	});
});
