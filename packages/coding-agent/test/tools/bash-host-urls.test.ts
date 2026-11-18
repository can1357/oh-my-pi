/**
 * Internal URLs in commands that leave the bash tool's own shell: the rewrite a client terminal's
 * command gets, checked against a fixed backing, and the shell processes a named service and a pty
 * command run as, through `BashTool` with a real `local://` root.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runEvalShell } from "@oh-my-pi/pi-coding-agent/eval/shell-bridge";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as brokerClients from "@oh-my-pi/pi-coding-agent/launch/client";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { hostCommandUrls, type UrlBacking } from "@oh-my-pi/pi-coding-agent/tools/bash-host-urls";
import { TUI } from "@oh-my-pi/pi-tui";
import { KeybindingsManager } from "@oh-my-pi/pi-tui/app-keybindings";
import { initTheme, type Theme, theme } from "@oh-my-pi/pi-tui/theme";
import type { DaemonSnapshot, DaemonSpec } from "@oh-my-pi/pi-tui/tools/daemon";
import { SHELL_PROCESS_SELECTOR } from "@oh-my-pi/pi-utils";
import { VirtualTerminal } from "../../../tui/test/virtual-terminal";

/** `local://<path>` is `/host/<path>`; `local://nope/…` is refused; nothing else is backed. */
const backing: UrlBacking = async url => {
	if (url.startsWith("local://nope")) throw new Error("ENOENT");
	return url.startsWith("local://") ? `/host/${url.slice("local://".length)}` : undefined;
};

const host = (command: string, shell?: string) => hostCommandUrls(command, backing, shell);

describe("hostCommandUrls", () => {
	it("names the file behind a URL argument, bare or attached to an option", async () => {
		expect(
			await host(
				"node local://run.mjs --env-file=local://a.env -olocal://out.json -F body=@local://b.md --data-binary @local://c.json",
			),
		).toBe(
			"node /host/run.mjs --env-file=/host/a.env -o/host/out.json -F body=@/host/b.md --data-binary @/host/c.json",
		);
	});

	it("resolves quoted words, redirections, assignments and command substitutions", async () => {
		expect(await host(`gh pr edit --body-file "local://b.md"`)).toBe("gh pr edit --body-file /host/b.md");
		expect(await host("python3 - <local://in.py 2>>local://err.log > local://out.txt")).toBe(
			"python3 - </host/in.py 2>>/host/err.log > /host/out.txt",
		);
		expect(await host("ENV_FILE=local://a.env uv run python local://smoke.py")).toBe(
			"ENV_FILE=/host/a.env uv run python /host/smoke.py",
		);
		expect(await host(`node "$(realpath local://ui.cjs)" -p "$(cat local://prompt.txt)" $(cat local://x)`)).toBe(
			`node "$(realpath /host/ui.cjs)" -p "$(cat /host/prompt.txt)" $(cat /host/x)`,
		);
	});

	it("quotes a path the shell would otherwise split, keeping a pattern live", async () => {
		const spaced: UrlBacking = async url => `/Users/a b/${url.slice("local://".length)}`;
		expect(await hostCommandUrls(`cat --from="local://it's.txt"`, spaced)).toBe(
			`cat '--from=/Users/a b/it'\\''s.txt'`,
		);
		expect(await hostCommandUrls("wc -l local://logs/*.txt 'local://logs/*.txt'", spaced)).toBe(
			"wc -l '/Users/a b/logs/'*.txt '/Users/a b/logs/*.txt'",
		);
		expect(await hostCommandUrls("type local://a.txt", spaced, "C:\\Windows\\System32\\cmd.exe")).toBe(
			'type "/Users/a b/a.txt"',
		);
	});

	it("leaves omp's own URLs, message text, and what nothing backs as written", async () => {
		for (const command of [
			"omp read 'skill://tdd:1-14' local://x.md",
			"sudo /usr/local/bin/omp read local://x.md",
			"curl https://example.com/a.txt -H 'Referer: https://example.com/?next=local://x'",
			"log.sh 'local://handover.md is ready for review'",
			"bm read memory://notes/startup local://nope/missing.md",
			"rg -n 'local://' src; echo 'skill:// external command'",
			`echo "$dir/local://x" 'see $(cat local://x)'`,
		]) {
			expect(await host(command)).toBe(command);
		}
		// The next command after `omp` is no longer its own.
		expect(await host("omp read local://x.md && cat local://x.md | omp -p local://y")).toBe(
			"omp read local://x.md && cat /host/x.md | omp -p local://y",
		);
	});

	it("treats a here-document body as input, not command text", async () => {
		const command = [
			"python3 - local://args.json <<'PY' && cat local://after.txt",
			'open("local://inside.txt")',
			"PY",
			"node local://tail.mjs <<-EOF",
			"\tlocal://body",
			"\tEOF",
			"cat local://done.txt",
		].join("\n");
		expect(await host(command)).toBe(
			[
				"python3 - /host/args.json <<'PY' && cat /host/after.txt",
				'open("local://inside.txt")',
				"PY",
				"node /host/tail.mjs <<-EOF",
				"\tlocal://body",
				"\tEOF",
				"cat /host/done.txt",
			].join("\n"),
		);
	});
});

type InteractiveUi = Pick<NonNullable<AgentToolContext["ui"]>, "custom">;

/** A UI whose `custom()` mounts the pty overlay on a headless TUI and resolves with its result. */
function headlessUi(): InteractiveUi {
	const custom: InteractiveUi["custom"] = async <T>(
		factory: (tui: TUI, uiTheme: Theme, keybindings: KeybindingsManager, done: (result: T) => void) => unknown,
	): Promise<T> => {
		const { promise, resolve } = Promise.withResolvers<T>();
		await factory(new TUI(new VirtualTerminal(100, 30)), theme, KeybindingsManager.inMemory(), resolve);
		return promise;
	};
	return { custom };
}

const ptyUnavailable = process.platform === "win32" || Bun.env.PI_NO_PTY === "1" || !fs.existsSync("/bin/bash");

describe("bash internal URLs outside the embedded shell", () => {
	let tempDir: string;
	let localRoot: string;
	let session: ToolSession;
	/** Prints its arguments, then `$BODY` when set, one per line. */
	let argvScript: string;

	beforeEach(async () => {
		tempDir = await fs.promises.realpath(await fs.promises.mkdtemp(path.join(os.tmpdir(), "bash-host-urls-")));
		const localProtocolOptions = { getArtifactsDir: () => tempDir, getSessionId: () => "bash-host-urls" };
		localRoot = resolveLocalRoot(localProtocolOptions);
		await fs.promises.mkdir(localRoot, { recursive: true });
		await fs.promises.writeFile(path.join(localRoot, "data.txt"), "payload-from-local\n");
		argvScript = path.join(tempDir, "argv.js");
		await fs.promises.writeFile(
			argvScript,
			"console.log(process.argv.slice(2).concat(process.env.BODY ?? []).join('\\n'));\n",
		);
		session = {
			cwd: tempDir,
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => "bash-host-urls",
			getSessionSpawns: () => "*",
			getAgentId: () => "Main",
			queueLaunchCompletion: () => Promise.resolve(),
			queueServiceNotify: () => {},
			localProtocolOptions,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			getClientBridge: () => undefined,
		} as unknown as ToolSession;
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	it("starts a named service as a shell process that gets its command as written", async () => {
		const daemon: DaemonSnapshot = {
			name: "web",
			id: "web-1",
			state: "running",
			pid: 1,
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			owner: "bash-host-urls",
			persist: false,
			detached: false,
		};
		let started: DaemonSpec | undefined;
		const client: brokerClients.DaemonBrokerClient = {
			projectDir: tempDir,
			onCompletion: () => () => {},
			onNotify: () => () => {},
			close() {},
			async request(operation) {
				if (operation.op === "start") {
					started = operation.spec;
					return { op: "start", daemon, readyTimedOut: false, notifyArmed: false };
				}
				if (operation.op === "logs") {
					return { op: "logs", name: "web", text: "", cursor: 0, timedOut: false, state: "running" };
				}
				throw new Error(`Unexpected broker op ${operation.op}`);
			},
		};
		vi.spyOn(brokerClients, "daemonClientForProject").mockResolvedValue(client);

		await new BashTool(session).execute("start-web", {
			command: `SEED=local://data.txt uv run python local://serve.py --prompt "$(cat local://data.txt)" < local://data.txt; omp read local://data.txt:1-2`,
			name: "web",
		});

		// The engine in that process resolves the URLs itself, to the files this session backs them with.
		const args = started?.args ?? [];
		expect(args.at(-1)).toBe(
			`SEED=local://data.txt uv run python local://serve.py --prompt "$(cat local://data.txt)" < local://data.txt; omp read local://data.txt:1-2`,
		);
		expect(args.at(-2)).toBe("--");
		expect(args).toContain(SHELL_PROCESS_SELECTOR);
		expect(args[args.indexOf(SHELL_PROCESS_SELECTOR) + 1]).toBe("--paths");
		expect(JSON.parse(args[args.indexOf(SHELL_PROCESS_SELECTOR) + 2])).toMatchObject({ local: localRoot });
	});

	it.skipIf(ptyUnavailable)("runs a pty command on the files its URLs alias", async () => {
		initTheme();
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: "/bin/bash",
			args: ["-c"],
			env: { PATH: Bun.env.PATH ?? "", HOME: tempDir, TERM: "dumb" },
			prefix: undefined,
		});
		const result = await new BashTool({ ...session, hasUI: true } as ToolSession).execute(
			"pty",
			{
				command: `/bin/cat local://data.txt && '${process.execPath}' '${argvScript}' local://data.txt > local://pty-out.txt`,
				pty: true,
				timeout: 15,
			},
			undefined,
			undefined,
			{ hasUI: true, ui: headlessUi() } as unknown as AgentToolContext,
		);

		const text = result.content.find(c => c.type === "text")?.text ?? "";
		expect(text).toContain("payload-from-local");
		expect(await fs.promises.readFile(path.join(localRoot, "pty-out.txt"), "utf-8")).toBe(
			`${path.join(localRoot, "data.txt")}\n`,
		);
	});

	it.skipIf(ptyUnavailable)(
		"runs a pty command in the session's shell: omp's jq on a local:// file, the session's functions and exports",
		async () => {
			initTheme();
			vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
				shell: "/bin/bash",
				args: ["-c"],
				env: { PATH: Bun.env.PATH ?? "", HOME: tempDir, TERM: "dumb" },
				prefix: undefined,
			});
			const empty = path.join(tempDir, "empty");
			await fs.promises.mkdir(empty);
			await fs.promises.writeFile(path.join(localRoot, "data.json"), '{"a":[40,2]}\n');
			const tool = new BashTool({ ...session, hasUI: true } as ToolSession);
			// An earlier call of the session leaves a function and an export behind.
			await tool.execute("define", { command: 'label() { echo "sum=$1 $SEEDED"; }; export SEEDED=seeded' });

			const result = await tool.execute(
				"pty-jq",
				{
					// No directory on the search path has a jq: the one that runs is omp's.
					command: `PATH='${empty}'; label "$(jq '.a | add' local://data.json)" > local://sum.txt; [ -t 1 ] && echo on-a-terminal`,
					pty: true,
					timeout: 30,
				},
				undefined,
				undefined,
				{ hasUI: true, ui: headlessUi() } as unknown as AgentToolContext,
			);

			const text = result.content.find(c => c.type === "text")?.text ?? "";
			expect(text).toContain("on-a-terminal");
			expect(await fs.promises.readFile(path.join(localRoot, "sum.txt"), "utf-8")).toBe("sum=42 seeded\n");
		},
		60_000,
	);

	it("hands an eval sh() external the files its URL arguments alias", async () => {
		const result = await runEvalShell(
			{
				command: `BODY=local://data.txt '${process.execPath}' '${argvScript}' --body-file=local://data.txt`,
			},
			{ session },
		);

		const data = path.join(localRoot, "data.txt");
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe(`--body-file=${data}\n${data}\n`);
	});
});
