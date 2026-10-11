import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	createDefaultTerminalLaunchRequest,
	createTerminalLauncher,
	getTerminalLaunchPlacement,
	type TerminalLaunchCliResult,
	type TerminalLaunchCliRunner,
	TerminalLaunchError,
	type TerminalLaunchRequest,
} from "../src/subprocess/terminal-launch";
import { processCli } from "../src/subprocess/terminal-launch/shared";

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

type ZellijWindowTargetIsExcluded = AssertFalse<
	IsAssignable<
		{ multiplexer: "zellij"; placement: "window"; command: readonly string[]; cwd: string; target: string },
		TerminalLaunchRequest
	>
>;
type ZellijFloatingDirectionIsExcluded = AssertFalse<
	IsAssignable<
		{
			multiplexer: "zellij";
			placement: "pane";
			command: readonly string[];
			cwd: string;
			floating: true;
			direction: "right";
		},
		TerminalLaunchRequest
	>
>;
type CmuxFocusIsSupported = AssertTrue<
	IsAssignable<
		{
			multiplexer: "cmux";
			placement: "pane";
			command: readonly string[];
			cwd: string;
			shellGrammar: "posix";
			focus: false;
		},
		TerminalLaunchRequest
	>
>;
type ScreenLaunchIsExcluded = AssertFalse<
	IsAssignable<
		{ multiplexer: "screen"; placement: "pane"; command: readonly string[]; cwd: string },
		TerminalLaunchRequest
	>
>;
type WmuxLaunchIsExcluded = AssertFalse<
	IsAssignable<
		{ multiplexer: "wmux"; placement: "window"; command: readonly string[]; cwd: string },
		TerminalLaunchRequest
	>
>;
type HerdrShellGrammarIsRequired = AssertFalse<
	IsAssignable<
		{ multiplexer: "herdr"; placement: "pane"; command: readonly string[]; cwd: string },
		TerminalLaunchRequest
	>
>;
type HerdrWindowShellGrammarIsRequired = AssertFalse<
	IsAssignable<
		{ multiplexer: "herdr"; placement: "window"; command: readonly string[]; cwd: string },
		TerminalLaunchRequest
	>
>;
type CmuxWindowShellGrammarIsRequired = AssertFalse<
	IsAssignable<
		{ multiplexer: "cmux"; placement: "window"; command: readonly string[]; cwd: string },
		TerminalLaunchRequest
	>
>;
type CmuxPaneShellGrammarIsRequired = AssertFalse<
	IsAssignable<
		{ multiplexer: "cmux"; placement: "pane"; command: readonly string[]; cwd: string },
		TerminalLaunchRequest
	>
>;

type OrcaWindowWorktreeOptionsAreSupported = AssertTrue<
	IsAssignable<
		{
			multiplexer: "orca";
			placement: "window";
			command: readonly string[];
			cwd: string;
			target: "path:/workspace";
			name: string;
			focus: true;
			shellGrammar: "posix";
		},
		TerminalLaunchRequest
	>
>;
type OrcaPaneFocusIsExcluded = AssertFalse<
	IsAssignable<
		{
			multiplexer: "orca";
			placement: "pane";
			command: readonly string[];
			cwd: string;
			shellGrammar: "posix";
			focus: true;
		},
		TerminalLaunchRequest
	>
>;
type OrcaPaneShellGrammarIsRequired = AssertFalse<
	IsAssignable<
		{ multiplexer: "orca"; placement: "pane"; command: readonly string[]; cwd: string },
		TerminalLaunchRequest
	>
>;
type OrcaPaneDirectionIsRestricted = AssertFalse<
	IsAssignable<
		{
			multiplexer: "orca";
			placement: "pane";
			command: readonly string[];
			cwd: string;
			shellGrammar: "posix";
			direction: "left";
		},
		TerminalLaunchRequest
	>
>;
const terminalLaunchTypeChecks: [
	ZellijWindowTargetIsExcluded,
	ZellijFloatingDirectionIsExcluded,
	CmuxFocusIsSupported,
	ScreenLaunchIsExcluded,
	WmuxLaunchIsExcluded,
	HerdrShellGrammarIsRequired,
	HerdrWindowShellGrammarIsRequired,
	CmuxWindowShellGrammarIsRequired,
	CmuxPaneShellGrammarIsRequired,
	OrcaWindowWorktreeOptionsAreSupported,
	OrcaPaneFocusIsExcluded,
	OrcaPaneShellGrammarIsRequired,
	OrcaPaneDirectionIsRestricted,
] = [false, false, true, false, false, false, false, false, false, true, false, false, false];
void terminalLaunchTypeChecks;

describe("generic terminal launch construction", () => {
	it("reports missing and unsupported launch providers with the supported set", () => {
		const missing = getTerminalLaunchPlacement(null, "pane");
		if (!("error" in missing)) throw new Error("missing multiplexer unexpectedly resolved");
		expect(missing.error).toContain("No terminal multiplexer was detected");
		for (const provider of ["Herdr", "tmux", "Zellij", "CMUX"]) {
			expect(missing.error).toContain(provider);
		}

		for (const multiplexer of ["screen", "wmux"] as const) {
			const unsupported = getTerminalLaunchPlacement(multiplexer, "pane");
			if (!("error" in unsupported)) throw new Error(`${multiplexer} unexpectedly supports launches`);
			expect(unsupported.error).toContain(multiplexer);
			expect(unsupported.error).toContain("does not support terminal launches");
		}
	});

	it("rejects unconfirmed shell grammar and leaves optional provider defaults unset", () => {
		const unconfirmed = createDefaultTerminalLaunchRequest("herdr", "pane", ["omp", "--resume"], "/repo");
		if (!("error" in unconfirmed)) throw new Error("shell-input request unexpectedly omitted its grammar error");
		expect(unconfirmed.error).toContain('requires shellGrammar: "posix"');

		const confirmed = createDefaultTerminalLaunchRequest("herdr", "pane", ["omp", "--resume"], "/repo", "posix");
		if ("error" in confirmed) throw new Error(confirmed.error);
		for (const option of ["target", "focus", "direction", "execution"]) {
			expect(Object.hasOwn(confirmed.request, option)).toBe(false);
		}
	});
});

describe("terminal launch dispatcher", () => {
	it("runs tmux pane commands with direct argv, explicit target, cwd, focus, and pane ID", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, [
			{ stdout: "%19\n", exitCode: 0 },
		]);

		const result = await launch({
			multiplexer: "tmux",
			placement: "pane",
			command: ["omp", "--fork", "session.jsonl"],
			cwd: "/workspace/project",
			target: "%7",
			focus: false,
			direction: "right",
			execution: "direct",
		});

		expect(calls).toEqual([
			{
				argv: [
					"tmux",
					"split-window",
					"-h",
					"-d",
					"-c",
					"/workspace/project",
					"-t",
					"%7",
					"-P",
					"-F",
					"#{pane_id}",
					"--",
					"omp",
					"--fork",
					"session.jsonl",
				],
				cwd: "/workspace/project",
			},
		]);
		expect(result).toEqual({ multiplexer: "tmux", placement: "pane", id: "%19" });
	});

	it("shell-quotes tmux argv without interpreting argument text", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, [
			{ stdout: "@5\n", exitCode: 0 },
		]);

		const result = await launch({
			multiplexer: "tmux",
			placement: "window",
			command: ["echo", "a'b; $(touch marker)"],
			cwd: "/tmp/work",
			target: "$0",
			execution: "shell",
		});

		expect(calls[0].argv).toEqual([
			"tmux",
			"new-window",
			"-c",
			"/tmp/work",
			"-t",
			"$0",
			"-P",
			"-F",
			"#{window_id}",
			"--",
			"/bin/sh",
			"-c",
			"'echo' 'a'\\''b; $(touch marker)'",
		]);
		expect(result).toEqual({ multiplexer: "tmux", placement: "window", id: "@5" });
	});

	it("passes # in the tmux start directory literally instead of as a format", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, [
			{ stdout: "%24\n", exitCode: 0 },
		]);
		const cwd = "/work/#S/#(touch pwned)/##{pane_id}";
		await launch({ multiplexer: "tmux", placement: "pane", command: ["omp", "--resume"], cwd });

		expect(calls[0]!.argv[calls[0]!.argv.indexOf("-c") + 1]).toBe("/work/##S/##(touch pwned)/####{pane_id}");
		expect(calls[0]!.cwd).toBe(cwd);
	});

	it("directly launches one-element tmux commands without parsing executable text", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, [
			{ stdout: "%20\n", exitCode: 0 },
			{ stdout: "%21\n", exitCode: 0 },
		]);
		const executables = ["/tmp/a path/evil; $(touch marker)", "-evil; $(touch marker)"];
		for (const executable of executables) {
			await launch({
				multiplexer: "tmux",
				placement: "pane",
				command: [executable],
				cwd: "/repo",
			});
		}

		expect(calls.map(call => call.argv.slice(call.argv.indexOf("--") + 1))).toEqual(
			executables.map(executable => ["/usr/bin/env", "--", executable]),
		);
	});

	it("keeps newline data in direct tmux argv", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, [
			{ stdout: "%22\n", exitCode: 0 },
		]);
		const command = ["printf", "%s", "first line\nsecond line"];

		await launch({ multiplexer: "tmux", placement: "pane", command, cwd: "/repo" });

		expect(calls[0]!.argv.slice(calls[0]!.argv.indexOf("--") + 1)).toEqual(command);
	});

	it("rejects a one-element direct executable that env would parse as an assignment", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, []);
		await expect(
			launch({
				multiplexer: "tmux",
				placement: "pane",
				command: ["command=value"],
				cwd: "/repo",
			}),
		).rejects.toThrow("cannot safely run a single executable");
		expect(calls).toEqual([]);
	});

	it("creates a tmux window in the current session without using TMUX_PANE as a window target", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, [
			{ stdout: "@6\n", exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "tmux",
			placement: "window",
			command: ["omp", "--resume"],
			cwd: "/repo",
		});

		expect(calls[0].argv).toEqual([
			"tmux",
			"new-window",
			"-c",
			"/repo",
			"-P",
			"-F",
			"#{window_id}",
			"--",
			"omp",
			"--resume",
		]);
		expect(result).toEqual({ multiplexer: "tmux", placement: "window", id: "@6" });
	});

	it("rejects tmux pane and window IDs as new-window session targets", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0" }, []);
		for (const target of ["%7", "@4"]) {
			await expect(
				launch({ multiplexer: "tmux", placement: "window", command: ["omp"], cwd: "/repo", target }),
			).rejects.toThrow("session ID or name");
		}
		expect(calls).toEqual([]);
	});

	it("does not infer tmux capability from TERM and requires a pane target", async () => {
		const { calls, launch } = createHarness({ TERM: "tmux-256color" }, []);
		await expect(launch({ multiplexer: "tmux", placement: "pane", command: ["omp"], cwd: "/repo" })).rejects.toThrow(
			"active TMUX session",
		);
		expect(calls).toEqual([]);

		const noPane = createHarness({ TMUX: "/tmp/tmux.sock,1,0" }, []);
		await expect(
			noPane.launch({ multiplexer: "tmux", placement: "pane", command: ["omp"], cwd: "/repo" }),
		).rejects.toThrow("target pane ID or TMUX_PANE");
		expect(noPane.calls).toEqual([]);
	});

	it("allows tmux pane and session targets when TMUX is absent", async () => {
		const pane = createHarness({}, [{ stdout: "%21\n", exitCode: 0 }]);
		const paneResult = await pane.launch({
			multiplexer: "tmux",
			placement: "pane",
			command: ["omp"],
			cwd: "/repo",
			target: "%7",
		});
		expect(pane.calls[0].argv).toContain("%7");
		expect(paneResult.id).toBe("%21");

		const window = createHarness({}, [{ stdout: "@8\n", exitCode: 0 }]);
		const windowResult = await window.launch({
			multiplexer: "tmux",
			placement: "window",
			command: ["omp"],
			cwd: "/repo",
			target: "session:review",
		});
		expect(window.calls[0].argv).toContain("session:review");
		expect(windowResult.id).toBe("@8");
	});

	it("rejects canonical multiplexer kinds without a launcher capability", async () => {
		for (const multiplexer of ["screen", "wmux"] as const) {
			const { calls, launch } = createHarness({}, []);
			const request = {
				multiplexer,
				placement: "pane",
				command: ["omp"],
				cwd: "/repo",
			} as unknown as TerminalLaunchRequest;

			await expect(launch(request)).rejects.toThrow(multiplexer);
			await expect(launch(request)).rejects.toBeInstanceOf(TerminalLaunchError);
			expect(calls).toEqual([]);
		}
	});

	it("rejects malformed requests with TypeError and relative cwd before invoking a CLI", async () => {
		const { calls, launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%2" }, []);
		const unknown = { multiplexer: "kitty", placement: "pane", command: ["omp"], cwd: "/repo" };
		await expect(launch(unknown as unknown as TerminalLaunchRequest)).rejects.toBeInstanceOf(TypeError);

		const relative = launch({ multiplexer: "tmux", placement: "pane", command: ["omp"], cwd: "sub" });
		await expect(relative).rejects.toBeInstanceOf(TerminalLaunchError);
		await expect(relative).rejects.toThrow("must be an absolute path");
		expect(calls).toEqual([]);
	});

	it("does not treat CMUX transport or socket overrides as an active surface", async () => {
		const { calls, launch } = createHarness({ CMUX_REMOTE_TRANSPORT: "ssh", CMUX_SOCKET_PATH: "/tmp/cmux.sock" }, []);
		await expect(
			launch({
				multiplexer: "cmux",
				placement: "pane",
				command: ["npm", "run", "dev"],
				cwd: "/repo",
				shellGrammar: "posix",
			}),
		).rejects.toThrow("CMUX context or explicit target ID");
		expect(calls).toEqual([]);
	});

	it("targets an explicit CMUX surface without inheriting the ambient workspace", async () => {
		const { calls, launch } = createHarness(
			{
				CMUX_REMOTE_TRANSPORT: "ssh",
				CMUX_WORKSPACE_ID: "workspace:ambient",
				CMUX_SURFACE_ID: "surface:ambient",
			},
			[{ stdout: '{"pane_id":"pane-9"}', exitCode: 0 }],
		);
		const result = await launch({
			multiplexer: "cmux",
			placement: "pane",
			command: ["printf", "%s", "explicit CMUX command"],
			cwd: process.cwd(),
			target: "surface:9",
			direction: "down",
			shellGrammar: "posix",
		});

		const commandIndex = calls[0]!.argv.indexOf("--command");
		expect(calls[0]!.argv.slice(0, commandIndex + 1)).toEqual([
			"cmux",
			"--json",
			"new-split",
			"down",
			"--surface",
			"surface:9",
			"--command",
		]);
		expect(calls[0]!.cwd).toBe(process.cwd());
		// CMUX new-split restores CMUX_WORKSPACE_ID from its environment even with --surface.
		expect(calls[0]!.env?.CMUX_WORKSPACE_ID).toBeUndefined();
		expect(calls[0]!.env?.CMUX_SURFACE_ID).toBe("surface:ambient");
		if (process.platform !== "win32") {
			const commandProbe = await processCli(["/bin/sh", "-c", calls[0]!.argv[commandIndex + 1]!], process.cwd());
			expect(commandProbe.exitCode).toBe(0);
			expect(commandProbe.stdout).toBe("explicit CMUX command");
		}
		expect(result).toEqual({ multiplexer: "cmux", placement: "pane", id: "pane-9" });
	});

	it("runs a Zellij pane directly and targets its tab", async () => {
		const { calls, launch } = createHarness({ ZELLIJ: "0", ZELLIJ_PANE_ID: "3" }, [
			{ stdout: "zellij 0.45.1\n", exitCode: 0 },
			{ stdout: '[{"tab_id":8}]', exitCode: 0 },
			{ stdout: "12\n", exitCode: 0 },
			{ stdout: "13\n", exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "zellij",
			placement: "pane",
			command: ["bun", "run", "dev"],
			cwd: "/workspace",
			target: "8",
			direction: "down",
			name: "server",
			focus: false,
			execution: "direct",
		});

		expect(calls).toEqual([
			{
				argv: ["zellij", "--version"],
				cwd: "/workspace",
			},
			{
				argv: ["zellij", "action", "list-tabs", "--json"],
				cwd: "/workspace",
			},
			{
				argv: [
					"zellij",
					"action",
					"new-pane",
					"--direction",
					"down",
					"--tab-id",
					"8",
					"--name",
					"server",
					"--cwd",
					"/workspace",
					"--no-focus",
					"--",
					"bun",
					"run",
					"dev",
				],
				cwd: "/workspace",
			},
		]);
		expect(result).toEqual({ multiplexer: "zellij", placement: "pane", id: "terminal_12" });

		// The probed version is reused for later launches.
		await launch({ multiplexer: "zellij", placement: "pane", command: ["omp"], cwd: "/workspace", focus: false });
		expect(calls.slice(3).map(call => call.argv.slice(0, 3))).toEqual([["zellij", "action", "new-pane"]]);
	});

	it("names the minimum Zellij version instead of passing flags an older CLI rejects", async () => {
		const noFocus = createHarness({ ZELLIJ: "0" }, [{ stdout: "zellij 0.44.3\n", exitCode: 0 }]);
		await expect(
			noFocus.launch({ multiplexer: "zellij", placement: "window", command: ["omp"], cwd: "/repo", focus: false }),
		).rejects.toThrow("new-tab --no-focus requires Zellij 0.45.0 or newer (found 0.44.3)");
		expect(noFocus.calls.map(call => call.argv)).toEqual([["zellij", "--version"]]);

		const tabTarget = createHarness({ ZELLIJ: "0" }, [{ stdout: "zellij 0.44.0\n", exitCode: 0 }]);
		await expect(
			tabTarget.launch({ multiplexer: "zellij", placement: "pane", command: ["omp"], cwd: "/repo", target: "8" }),
		).rejects.toThrow("new-pane --tab-id requires Zellij 0.44.1 or newer (found 0.44.0)");
		expect(tabTarget.calls.map(call => call.argv)).toEqual([["zellij", "--version"]]);

		const tab = createHarness({ ZELLIJ: "0" }, [{ stdout: "zellij 0.43.1\n", exitCode: 0 }]);
		await expect(
			tab.launch({ multiplexer: "zellij", placement: "window", command: ["omp"], cwd: "/repo" }),
		).rejects.toThrow("new-tab -- <command> requires Zellij 0.44.0 or newer (found 0.43.1)");
		expect(tab.calls.map(call => call.argv)).toEqual([["zellij", "--version"]]);
	});

	it("reports a Zellij launch without an ID when an older CLI prints none", async () => {
		const { calls, launch } = createHarness({ ZELLIJ: "0" }, [{ stdout: "", exitCode: 0 }]);
		const result = await launch({ multiplexer: "zellij", placement: "pane", command: ["omp"], cwd: "/repo" });

		expect(result).toEqual({ multiplexer: "zellij", placement: "pane" });
		expect(calls).toHaveLength(1);
	});

	it("rejects a target that Zellij cannot apply to new-tab creation", async () => {
		const { calls, launch } = createHarness({ ZELLIJ: "0" }, []);
		const request = {
			multiplexer: "zellij",
			placement: "window",
			command: ["bun", "run", "dev"],
			cwd: "/workspace",
			target: "8",
		} as unknown as TerminalLaunchRequest;
		await expect(launch(request)).rejects.toThrow("does not accept a target");
		expect(calls).toEqual([]);
	});

	it("rejects Zellij floating panes combined with a split direction at runtime", async () => {
		const { calls, launch } = createHarness({ ZELLIJ: "1" }, []);
		const request = {
			multiplexer: "zellij",
			placement: "pane",
			command: ["omp"],
			cwd: "/repo",
			floating: true,
			direction: "right",
		} as unknown as TerminalLaunchRequest;

		await expect(launch(request)).rejects.toThrow("floating panes do not support a split direction");
		expect(calls).toEqual([]);
	});

	it("creates a Zellij tab directly and returns its tab ID", async () => {
		const { calls, launch } = createHarness({ ZELLIJ: "0" }, [
			{ stdout: "zellij 0.45.0\n", exitCode: 0 },
			{ stdout: "7\n", exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "zellij",
			placement: "window",
			command: ["bun", "run", "dev"],
			cwd: "/workspace",
			name: "review",
			focus: false,
			execution: "direct",
		});

		expect(calls[1]).toEqual({
			argv: [
				"zellij",
				"action",
				"new-tab",
				"--name",
				"review",
				"--cwd",
				"/workspace",
				"--no-focus",
				"--",
				"bun",
				"run",
				"dev",
			],
			cwd: "/workspace",
		});
		expect(result).toEqual({ multiplexer: "zellij", placement: "window", id: "7" });
	});

	it("creates a Herdr pane, parses its JSON ID, then runs a POSIX-shell command", async () => {
		const { calls, launch } = createHarness({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, [
			{ stdout: '{"result":{"pane":{"pane_id":"w1:p2"}}}', exitCode: 0 },
			{ stdout: "", exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "herdr",
			placement: "pane",
			command: ["bun", "run", "my script.ts", "x'y"],
			cwd: "/repo with space",
			direction: "down",
			focus: false,
			shellGrammar: "posix",
		});

		expect(calls).toEqual([
			{
				argv: ["herdr", "pane", "split", "w1:p1", "--direction", "down", "--cwd", "/repo with space", "--no-focus"],
				cwd: "/repo with space",
			},
			{
				argv: ["herdr", "pane", "run", "w1:p2", "'bun' 'run' 'my script.ts' 'x'\\''y'"],
				cwd: "/repo with space",
			},
		]);
		expect(result).toEqual({ multiplexer: "herdr", placement: "pane", id: "w1:p2" });
	});

	it("creates a Herdr tab in the explicit workspace and runs in its root pane", async () => {
		const { calls, launch } = createHarness({ HERDR_ENV: "1", HERDR_WORKSPACE_ID: "w1" }, [
			{
				stdout: '{"result":{"tab":{"tab_id":"w1:t2"},"root_pane":{"pane_id":"w1:p3"}}}',
				exitCode: 0,
			},
			{ stdout: "", exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "herdr",
			placement: "window",
			command: ["omp", "--resume"],
			cwd: "/repo",
			target: "w1",
			label: "agent",
			focus: true,
			shellGrammar: "posix",
		});

		expect(calls.map(call => call.argv)).toEqual([
			["herdr", "tab", "create", "--workspace", "w1", "--cwd", "/repo", "--label", "agent", "--focus"],
			["herdr", "pane", "run", "w1:p3", "'omp' '--resume'"],
		]);
		expect(result).toEqual({ multiplexer: "herdr", placement: "window", id: "w1:t2" });
	});

	it("preserves Unicode argv and pane cwd through ASCII-only CMUX shell input", async () => {
		const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cmux-unicode-"));
		try {
			const cwd = path.join(tempRoot, "cwd-Ω-雪");
			const recorder = path.join(tempRoot, "recorder.js");
			await fs.mkdir(cwd);
			await Bun.write(
				recorder,
				'process.stdout.write(JSON.stringify({ cwd: process.cwd(), argv: process.argv.slice(2) }) + "\\n");\n',
			);
			const args = ["Ω 雪", "", "  spaced  ", "it's 'quoted'", "; printf injected", "$(printf injected) * $HOME"];
			const command = [process.execPath, recorder, ...args];
			const { calls, launch } = createHarness({ CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1" }, [
				{ stdout: '{"pane_id":"pane-2"}', exitCode: 0 },
				{ stdout: '{"workspace_id":"workspace-2"}', exitCode: 0 },
			]);
			await launch({
				multiplexer: "cmux",
				placement: "pane",
				command,
				cwd,
				shellGrammar: "posix",
				execution: "shell-input",
			});
			await launch({
				multiplexer: "cmux",
				placement: "window",
				command,
				cwd,
				shellGrammar: "posix",
				execution: "shell-input",
			});
			const panePayload = calls[0]!.argv[calls[0]!.argv.indexOf("--command") + 1]!;
			const windowPayload = calls[1]!.argv[calls[1]!.argv.indexOf("--command") + 1]!;
			expect(panePayload).toMatch(/^[\x00-\x7f]*$/u);
			expect(panePayload).toContain("'; printf injected'");
			expect(windowPayload).toMatch(/^[\x00-\x7f]*$/u);
			expect(calls[0]!.cwd).toBe(cwd);
			expect(calls[1]!.argv[calls[1]!.argv.indexOf("--cwd") + 1]).toBe(cwd);
			if (process.platform !== "win32") {
				const paneResult = await processCli(["/bin/sh", "-c", `${panePayload}; pwd`], process.cwd());
				expect(paneResult.exitCode).toBe(0);
				const [recordedChild, shellCwd] = paneResult.stdout.trimEnd().split("\n");
				expect(JSON.parse(recordedChild!)).toEqual({ cwd, argv: args });
				expect(shellCwd).toBe(cwd);
				const windowResult = await processCli(["/bin/sh", "-c", windowPayload], cwd);
				expect(windowResult.exitCode).toBe(0);
				expect(JSON.parse(windowResult.stdout)).toEqual({ cwd, argv: args });
			}
		} finally {
			await fs.rm(tempRoot, { recursive: true, force: true });
		}
	});

	it("targets an explicit CMUX window without pre-focusing when focus is false", async () => {
		const { calls, launch } = createHarness({ CMUX_WORKSPACE_ID: "workspace:1" }, [
			{ stdout: '{"workspace_id":"workspace-2"}', exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "cmux",
			placement: "window",
			command: ["echo", "hello ' world"],
			cwd: "/repo",
			target: "window:4",
			name: "task",
			focus: false,
			execution: "shell-input",
			shellGrammar: "posix",
		});

		expect(calls[0].argv).toEqual([
			"cmux",
			"--json",
			"workspace",
			"create",
			"--window",
			"window:4",
			"--name",
			"task",
			"--cwd",
			"/repo",
			"--command",
			"'echo' 'hello '\\'' world'",
			"--focus",
			"false",
		]);
		expect(result).toEqual({ multiplexer: "cmux", placement: "window", id: "workspace-2" });
	});

	it("returns an unavailable ID when CMUX JSON omits the workspace ID", async () => {
		const { launch } = createHarness({ CMUX_WORKSPACE_ID: "workspace:1" }, [
			{ stdout: '{"name":"task"}', exitCode: 0 },
		]);
		const result = await launch({
			multiplexer: "cmux",
			placement: "window",
			command: ["omp"],
			cwd: "/repo",
			shellGrammar: "posix",
		});

		expect(result.id).toBeUndefined();
	});

	it("sanitizes backend errors so command text does not escape", async () => {
		const { launch } = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%3" }, [
			{ stdout: "TOP SECRET ARGUMENT", exitCode: 23 },
		]);
		const request = {
			multiplexer: "tmux",
			placement: "pane",
			command: ["omp", "--token", "TOP SECRET ARGUMENT"],
			cwd: "/repo",
		} as const;

		let caught: unknown;
		try {
			await launch(request);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("exit 23");
		expect((caught as Error).message).not.toContain("TOP SECRET ARGUMENT");
		expect((caught as Error).message).not.toContain("omp");
	});

	it("rejects malformed backend output instead of returning a guessed ID", async () => {
		const tmux = createHarness({ TMUX: "/tmp/tmux.sock,1,0", TMUX_PANE: "%3" }, [
			{ stdout: "not-a-pane-id", exitCode: 0 },
		]);
		await expect(
			tmux.launch({ multiplexer: "tmux", placement: "pane", command: ["omp"], cwd: "/repo" }),
		).rejects.toThrow("invalid ID");

		const herdr = createHarness({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, [{ stdout: "not-json", exitCode: 0 }]);
		await expect(
			herdr.launch({
				multiplexer: "herdr",
				placement: "pane",
				command: ["omp"],
				cwd: "/repo",
				shellGrammar: "posix",
			}),
		).rejects.toThrow("invalid JSON");

		const zellij = createHarness({ ZELLIJ: "1" }, [{ stdout: "terminal_not-a-number", exitCode: 0 }]);
		await expect(
			zellij.launch({ multiplexer: "zellij", placement: "pane", command: ["omp"], cwd: "/repo" }),
		).rejects.toThrow("invalid ID");

		const cmux = createHarness({ CMUX_WORKSPACE_ID: "workspace:1" }, [{ stdout: "OK workspace-2\n", exitCode: 0 }]);
		await expect(
			cmux.launch({
				multiplexer: "cmux",
				placement: "window",
				command: ["omp"],
				cwd: "/repo",
				shellGrammar: "posix",
			}),
		).rejects.toThrow("invalid JSON");
		expect(cmux.calls).toHaveLength(1);
		expect(cmux.calls[0].argv).toContain("workspace");
		expect(cmux.calls[0].argv).toContain("create");
		expect(cmux.calls[0].argv).not.toContain("new-workspace");
	});

	it("requires a POSIX destination-shell assertion for shell-input providers", async () => {
		const herdr = createHarness({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_WORKSPACE_ID: "w1" }, []);
		const cmux = createHarness({ CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1" }, []);
		const herdrPaneRequest = {
			multiplexer: "herdr",
			placement: "pane",
			command: ["omp"],
			cwd: "/repo",
		} as unknown as TerminalLaunchRequest;
		const herdrWindowRequest = {
			multiplexer: "herdr",
			placement: "window",
			command: ["omp"],
			cwd: "/repo",
		} as unknown as TerminalLaunchRequest;
		const cmuxPaneRequest = {
			multiplexer: "cmux",
			placement: "pane",
			command: ["omp"],
			cwd: "/repo",
		} as unknown as TerminalLaunchRequest;
		const cmuxWindowRequest = {
			multiplexer: "cmux",
			placement: "window",
			command: ["omp"],
			cwd: "/repo",
		} as unknown as TerminalLaunchRequest;

		await expect(herdr.launch(herdrPaneRequest)).rejects.toThrow('requires shellGrammar: "posix"');
		await expect(herdr.launch(herdrWindowRequest)).rejects.toThrow('requires shellGrammar: "posix"');
		await expect(cmux.launch(cmuxPaneRequest)).rejects.toThrow('requires shellGrammar: "posix"');
		await expect(cmux.launch(cmuxWindowRequest)).rejects.toThrow('requires shellGrammar: "posix"');
		expect(herdr.calls).toEqual([]);
		expect(cmux.calls).toEqual([]);
	});

	it("rejects terminal controls in shell-input requests before creating a surface", async () => {
		const herdr = createHarness({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }, []);
		const cmux = createHarness({ CMUX_WORKSPACE_ID: "workspace:1", CMUX_SURFACE_ID: "surface:1" }, []);
		for (const control of ["\u0003", "\u007f", "\u0085"]) {
			const payload = `before${control} touch marker`;
			await expect(
				herdr.launch({
					multiplexer: "herdr",
					placement: "pane",
					command: ["printf", "%s", payload],
					cwd: "/repo",
					shellGrammar: "posix",
				}),
			).rejects.toThrow("terminal control bytes");
			await expect(
				cmux.launch({
					multiplexer: "cmux",
					placement: "window",
					command: ["printf", "%s", payload],
					cwd: "/repo",
					shellGrammar: "posix",
				}),
			).rejects.toThrow("terminal control bytes");
		}

		await expect(
			cmux.launch({
				multiplexer: "cmux",
				placement: "pane",
				command: ["omp"],
				cwd: "/repo\u0003",
				shellGrammar: "posix",
			}),
		).rejects.toThrow("terminal control bytes");
		expect(herdr.calls).toEqual([]);
		expect(cmux.calls).toEqual([]);
	});

	it("resolves an Orca pane by worktree-scoped pane identity and preserves shell argument boundaries", async () => {
		const argument = "quoted ' text; printf injected; $(printf nested) *";
		const { calls, launch } = createHarness(
			{ ORCA_PANE_KEY: "tab-11:12345678-1234-1234-1234-123456789abc", ORCA_WORKTREE_ID: "worktree-1" },
			[
				{
					stdout: JSON.stringify({
						ok: true,
						id: "rpc-list-id",
						result: {
							totalCount: 2,
							truncated: false,
							terminals: [
								{
									handle: "term-other",
									worktreeId: "worktree-2",
									tabId: "tab-11",
									leafId: "12345678-1234-1234-1234-123456789abc",
								},
								{
									handle: "term-current",
									worktreeId: "worktree-1",
									tabId: "tab-11",
									leafId: "12345678-1234-1234-1234-123456789abc",
								},
							],
						},
					}),
					exitCode: 0,
				},
				{
					stdout: '{"ok":true,"id":"rpc-split-id","result":{"split":{"handle":"term-split"}}}',
					exitCode: 0,
				},
			],
		);

		const result = await launch({
			multiplexer: "orca",
			placement: "pane",
			command: ["printf", "%s", argument],
			cwd: "/tmp",
			direction: "down",
			shellGrammar: "posix",
		});

		const shellCommand = `cd '/tmp' && 'printf' '%s' 'quoted '\\'' text; printf injected; $(printf nested) *'`;
		expect(calls).toEqual([
			{
				argv: ["orca", "terminal", "list", "--worktree=id:worktree-1", "--json"],
				cwd: "/tmp",
			},
			{
				argv: [
					"orca",
					"terminal",
					"split",
					"--terminal=term-current",
					"--direction=vertical",
					`--command=${shellCommand}`,
					"--json",
				],
				cwd: "/tmp",
			},
		]);
		expect(result).toEqual({ multiplexer: "orca", placement: "pane", id: "term-split" });

		if (process.platform !== "win32") {
			const executed = Bun.spawnSync(["/bin/sh", "-c", shellCommand], { stdout: "pipe", stderr: "pipe" });
			expect(executed.exitCode).toBe(0);
			expect(executed.stdout.toString()).toBe(argument);
		}
	});

	it("resolves the calling Orca pane beyond the default terminal-list limit", async () => {
		const source = {
			handle: "term-current",
			worktreeId: "worktree-1",
			tabId: "tab-11",
			leafId: "12345678-1234-1234-1234-123456789abc",
		};
		const other = { ...source, handle: "term-other", tabId: "tab-10" };
		const { calls, launch } = createHarness(
			{ ORCA_PANE_KEY: `${source.tabId}:${source.leafId}`, ORCA_WORKTREE_ID: source.worktreeId },
			[
				{
					stdout: JSON.stringify({ ok: true, result: { terminals: [other], totalCount: 2, truncated: true } }),
					exitCode: 0,
				},
				{
					stdout: JSON.stringify({
						ok: true,
						result: { terminals: [other, source], totalCount: 2, truncated: false },
					}),
					exitCode: 0,
				},
				{ stdout: '{"ok":true,"result":{"split":{"handle":"term-new"}}}', exitCode: 0 },
			],
		);
		const result = await launch({
			multiplexer: "orca",
			placement: "pane",
			command: ["omp", "--fork", "/tmp/source.jsonl"],
			cwd: "/tmp",
			shellGrammar: "posix",
		});
		expect(calls[1]?.argv).toEqual(["orca", "terminal", "list", "--worktree=id:worktree-1", "--limit=2", "--json"]);
		expect(calls[2]?.argv.slice(0, 4)).toEqual(["orca", "terminal", "split", "--terminal=term-current"]);
		expect(result.id).toBe("term-new");
	});

	it("honors explicit Orca pane handles and maps both supported directions", async () => {
		const { calls, launch } = createHarness({}, [
			{ stdout: '{"ok":true,"result":{"split":{"handle":"term-right"}}}', exitCode: 0 },
			{ stdout: '{"ok":true,"result":{"split":{"handle":"term-down"}}}', exitCode: 0 },
		]);
		for (const [direction, expected] of [
			["right", "horizontal"],
			["down", "vertical"],
		] as const) {
			await launch({
				multiplexer: "orca",
				placement: "pane",
				command: ["echo", "safe"],
				cwd: "/repo",
				target: "term-explicit",
				direction,
				shellGrammar: "posix",
			});
			expect(calls.at(-1)?.argv).toEqual([
				"orca",
				"terminal",
				"split",
				"--terminal=term-explicit",
				`--direction=${expected}`,
				"--command=cd '/repo' && 'echo' 'safe'",
				"--json",
			]);
		}
		expect(calls).toHaveLength(2);
	});

	it("creates Orca terminals in the requested worktree with supported title and focus options", async () => {
		const { calls, launch } = createHarness({ ORCA_WORKTREE_ID: "worktree-from-runtime" }, [
			{
				stdout: '{"ok":true,"id":"rpc-create-id","result":{"terminal":{"handle":"term-created"}}}',
				exitCode: 0,
			},
			{
				stdout: '{"ok":true,"id":"rpc-create-id-2","result":{"terminal":{"handle":"term-created-2"}}}',
				exitCode: 0,
			},
		]);
		const explicit = await launch({
			multiplexer: "orca",
			placement: "window",
			command: ["printf", "%s", "literal; $(printf no)"],
			cwd: "/repo's path",
			target: "path:/other/worktree",
			name: "--agent's tests",
			focus: true,
			shellGrammar: "posix",
		});
		const implicit = await launch({
			multiplexer: "orca",
			placement: "window",
			command: ["omp"],
			cwd: "/repo",
			focus: false,
			shellGrammar: "posix",
		});

		expect(calls.map(call => call.argv)).toEqual([
			[
				"orca",
				"terminal",
				"create",
				"--worktree=path:/other/worktree",
				"--title=--agent's tests",
				"--focus",
				"--command=cd '/repo'\\''s path' && 'printf' '%s' 'literal; $(printf no)'",
				"--json",
			],
			[
				"orca",
				"terminal",
				"create",
				"--worktree=id:worktree-from-runtime",
				"--command=cd '/repo' && 'omp'",
				"--json",
			],
		]);
		expect(explicit).toEqual({ multiplexer: "orca", placement: "window", id: "term-created" });
		expect(implicit).toEqual({ multiplexer: "orca", placement: "window", id: "term-created-2" });
	});

	it.each([
		{
			name: "ORCA_CLI_COMMAND override",
			platform: "linux",
			env: { ORCA_CLI_COMMAND: " orca-wsl " },
			cli: "orca-wsl",
		},
		{ name: "dev checkout", platform: "darwin", env: { ORCA_DEV_REPO_ROOT: "/src/orca" }, cli: "orca-dev" },
		{ name: "Linux outside Orca", platform: "linux", env: {}, cli: "orca-ide" },
		{
			name: "Linux inside an Orca terminal",
			platform: "linux",
			env: { ORCA_PANE_KEY: "tab-1:leaf-1", ORCA_WORKTREE_ID: "worktree-1" },
			cli: "orca",
		},
		{ name: "macOS", platform: "darwin", env: {}, cli: "orca" },
	] as const)("resolves the Orca CLI for $name", async ({ platform, env, cli }) => {
		const { calls, launch } = createHarness(
			env,
			[{ stdout: '{"ok":true,"result":{"terminal":{"handle":"term-created"}}}', exitCode: 0 }],
			platform,
		);
		await launch({
			multiplexer: "orca",
			placement: "window",
			command: ["omp"],
			cwd: "/repo",
			target: "id:worktree-1",
			shellGrammar: "posix",
		});
		expect(calls[0]?.argv[0]).toBe(cli);
	});

	it("reports Orca's background-terminal fallback instead of a visible tab", async () => {
		const { launch } = createHarness({ ORCA_WORKTREE_ID: "worktree-1" }, [
			{
				stdout: JSON.stringify({
					ok: true,
					result: { terminal: { handle: "term-bg", surface: "background", warning: "UI not attached" } },
				}),
				exitCode: 0,
			},
			{
				stdout: JSON.stringify({ ok: true, result: { terminal: { handle: "term-visible", surface: "visible" } } }),
				exitCode: 0,
			},
		]);
		const request = {
			multiplexer: "orca",
			placement: "window",
			command: ["omp"],
			cwd: "/repo",
			shellGrammar: "posix",
		} as const;

		const background = await launch(request);
		expect(background.id).toBe("term-bg");
		expect(background.warning).toContain("background terminal");
		expect(await launch(request)).toEqual({ multiplexer: "orca", placement: "window", id: "term-visible" });
	});

	it("fails closed when an Orca pane identity is unavailable or cannot be uniquely matched", async () => {
		const noPaneKey = createHarness({ ORCA_WORKTREE_ID: "worktree-1" }, []);
		await expect(
			noPaneKey.launch({
				multiplexer: "orca",
				placement: "pane",
				command: ["omp"],
				cwd: "/repo",
				shellGrammar: "posix",
			}),
		).rejects.toThrow("ORCA_PANE_KEY");
		expect(noPaneKey.calls).toEqual([]);

		const noMatch = createHarness(
			{ ORCA_PANE_KEY: "tab-11:12345678-1234-1234-1234-123456789abc", ORCA_WORKTREE_ID: "worktree-1" },
			[
				{
					stdout:
						'{"ok":true,"result":{"terminals":[{"handle":"term-wrong","worktreeId":"worktree-2","tabId":"tab-11","leafId":"12345678-1234-1234-1234-123456789abc"}],"totalCount":1,"truncated":false}}',
					exitCode: 0,
				},
			],
		);
		await expect(
			noMatch.launch({
				multiplexer: "orca",
				placement: "pane",
				command: ["omp"],
				cwd: "/repo",
				shellGrammar: "posix",
			}),
		).rejects.toThrow("could not resolve ORCA_PANE_KEY");
		expect(noMatch.calls).toHaveLength(1);

		const ambiguous = createHarness(
			{ ORCA_PANE_KEY: "tab-11:12345678-1234-1234-1234-123456789abc", ORCA_WORKTREE_ID: "worktree-1" },
			[
				{
					stdout:
						'{"ok":true,"result":{"terminals":[{"handle":"term-1","worktreeId":"worktree-1","tabId":"tab-11","leafId":"12345678-1234-1234-1234-123456789abc"},{"handle":"term-2","worktreeId":"worktree-1","tabId":"tab-11","leafId":"12345678-1234-1234-1234-123456789abc"}],"totalCount":2,"truncated":false}}',
					exitCode: 0,
				},
			],
		);
		await expect(
			ambiguous.launch({
				multiplexer: "orca",
				placement: "pane",
				command: ["omp"],
				cwd: "/repo",
				shellGrammar: "posix",
			}),
		).rejects.toThrow("multiple terminal handles");
		expect(ambiguous.calls).toHaveLength(1);
	});

	it("requires successful Orca JSON envelopes and nested handles without leaking command data", async () => {
		const nonzero = createHarness({}, [{ stdout: "PRIVATE_ORCA_OUTPUT", exitCode: 23 }]);
		let nonzeroError: unknown;
		try {
			await nonzero.launch({
				multiplexer: "orca",
				placement: "pane",
				command: ["PRIVATE_ORCA_ARGUMENT"],
				cwd: "/repo",
				target: "term-target",
				shellGrammar: "posix",
			});
		} catch (error) {
			nonzeroError = error;
		}
		expect(nonzeroError).toBeInstanceOf(Error);
		expect((nonzeroError as Error).message).toContain("exit 23");
		expect((nonzeroError as Error).message).not.toContain("PRIVATE_ORCA_OUTPUT");
		expect((nonzeroError as Error).message).not.toContain("PRIVATE_ORCA_ARGUMENT");

		const rejected = createHarness({}, [
			{
				stdout: '{"ok":false,"id":"rpc-error-id","error":{"message":"PRIVATE_ORCA_ERROR"}}',
				exitCode: 0,
			},
		]);
		let rejectedError: unknown;
		try {
			await rejected.launch({
				multiplexer: "orca",
				placement: "window",
				command: ["PRIVATE_ORCA_ARGUMENT"],
				cwd: "/repo",
				target: "id:worktree-1",
				shellGrammar: "posix",
			});
		} catch (error) {
			rejectedError = error;
		}
		expect(rejectedError).toBeInstanceOf(Error);
		expect((rejectedError as Error).message).toContain("unsuccessful response");
		expect((rejectedError as Error).message).not.toContain("PRIVATE_ORCA_ERROR");
		expect((rejectedError as Error).message).not.toContain("PRIVATE_ORCA_ARGUMENT");

		const missing = createHarness({}, [{ stdout: '{"ok":true,"id":"rpc-id-only"}', exitCode: 0 }]);
		await expect(
			missing.launch({
				multiplexer: "orca",
				placement: "pane",
				command: ["omp"],
				cwd: "/repo",
				target: "term-target",
				shellGrammar: "posix",
			}),
		).rejects.toThrow("no terminal handle");
	});

	it("rejects Orca shell-control bytes before invoking the CLI", async () => {
		const { calls, launch } = createHarness({}, []);
		for (const control of ["\u0003", "\u007f", "\u0085"]) {
			await expect(
				launch({
					multiplexer: "orca",
					placement: "pane",
					command: ["printf", `%s${control}`],
					cwd: "/repo",
					target: "term-target",
					shellGrammar: "posix",
				}),
			).rejects.toThrow("terminal control bytes");
			await expect(
				launch({
					multiplexer: "orca",
					placement: "window",
					command: ["omp"],
					cwd: `/repo${control}`,
					target: "id:worktree-1",
					shellGrammar: "posix",
				}),
			).rejects.toThrow("terminal control bytes");
		}
		expect(calls).toEqual([]);
	});
});
