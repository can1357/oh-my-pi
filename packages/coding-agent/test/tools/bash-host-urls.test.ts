/**
 * Internal URLs in commands that leave the bash tool's own shell: the rewrite a client terminal's
 * command gets, checked against a fixed backing, and the shell processes a named service and a pty
 * command run as, through `BashTool` with a real `local://` root.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import * as daemonClients from "@oh-my-pi/pi-coding-agent/daemon/client";
import type { DaemonClient } from "@oh-my-pi/pi-coding-agent/daemon/protocol";
import { runEvalShell } from "@oh-my-pi/pi-coding-agent/eval/shell-bridge";
import { resolveLocalRoot } from "@oh-my-pi/pi-coding-agent/internal-urls";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { hostCommandUrls, type UrlBacking } from "@oh-my-pi/pi-coding-agent/tools/bash-host-urls";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings/keybindings";
import type { ProcSpec, UnitSnapshot } from "@oh-my-pi/pi-coding-agent/daemon/daemon-types";
import { SHELL_PROCESS_SELECTOR } from "@oh-my-pi/pi-utils";
import { extensionTheme } from "../../src/ui/extensions/render-output";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";

const restoreTheme = currentTheme();
afterAll(() => setCurrentTheme(restoreTheme));

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

	it("rewrites URLs when omp is an argument or option value, and skips only when omp is the command", async () => {
		expect(await host("grep omp local://out.txt")).toBe("grep omp /host/out.txt");
		expect(await host("rg -n 'omp' local://SKILL.md")).toBe("rg -n 'omp' /host/SKILL.md");
		expect(await host("ls ./omp local://dir")).toBe("ls ./omp /host/dir");
		expect(await host("nice -n 5 grep omp local://out.txt")).toBe("nice -n 5 grep omp /host/out.txt");
		expect(await host("npx --cache omp eslint local://app.ts")).toBe("npx --cache omp eslint /host/app.ts");
		expect(await host("npx -p omp eslint local://app.ts")).toBe("npx -p omp eslint /host/app.ts");
		expect(await host("npx --loglevel warn omp read local://x.md:1")).toBe(
			"npx --loglevel warn omp read local://x.md:1",
		);
		expect(await host("bunx --minimum-release-age 86400 --registry https://r.test omp read local://book.md:1")).toBe(
			"bunx --minimum-release-age 86400 --registry https://r.test omp read local://book.md:1",
		);
		expect(await host("env -u omp grep x local://out.txt")).toBe("env -u omp grep x /host/out.txt");
		expect(await host("env -- -flag=/opt/omp grep x local://out.txt")).toBe(
			"env -- -flag=/opt/omp grep x /host/out.txt",
		);
		expect(await host("env - tool.name=/opt/omp grep x local://out.txt")).toBe(
			"env - tool.name=/opt/omp grep x /host/out.txt",
		);
		expect(await host("env - omp read local://x.md:1")).toBe("env - omp read local://x.md:1");
		expect(await host("timeout -k 5 30 omp read local://x.md && timeout 30 grep omp local://x.md")).toBe(
			"timeout -k 5 30 omp read local://x.md && timeout 30 grep omp /host/x.md",
		);
		expect(await host("setsid omp read local://x.md:1 && setsid grep omp local://x.md")).toBe(
			"setsid omp read local://x.md:1 && setsid grep omp /host/x.md",
		);
		expect(await host("xargs -n 1 omp read local://x.md && xargs -n 1 grep omp local://x.md")).toBe(
			"xargs -n 1 omp read local://x.md && xargs -n 1 grep omp /host/x.md",
		);
		expect(await host("ifne omp read local://x.md && ifne grep omp local://x.md")).toBe(
			"ifne omp read local://x.md && ifne grep omp /host/x.md",
		);
		expect(await host("REF=local://ref.txt omp read local://x.md && REF=local://ref.txt cat local://x.md")).toBe(
			"REF=local://ref.txt omp read local://x.md && REF=/host/ref.txt cat /host/x.md",
		);
		expect(await host("if omp read local://x.md; then cat local://y.md; fi")).toBe(
			"if omp read local://x.md; then cat /host/y.md; fi",
		);
		expect(await host("if grep omp local://x.md; then :; fi")).toBe("if grep omp /host/x.md; then :; fi");
		expect(await host("echo hi >& local://out.txt")).toBe("echo hi >& /host/out.txt");
		expect(await host("xargs -a local://list omp read local://x.md")).toBe(
			"xargs -a /host/list omp read local://x.md",
		);
		expect(await host("/usr/bin/env -C local://dir omp --version")).toBe("/usr/bin/env -C /host/dir omp --version");
		expect(await host("uv run omp read local://x.md && uv run -m omp local://x.md")).toBe(
			"uv run omp read local://x.md && uv run -m omp /host/x.md",
		);
		expect(await host("uv run --directory local://proj omp read local://x.md")).toBe(
			"uv run --directory /host/proj omp read local://x.md",
		);
		expect(await host(`REF="$(cat local://ref.txt)" omp --version`)).toBe(`REF="$(cat /host/ref.txt)" omp --version`);
		expect(await host(`omp read "$(cat local://ref.txt)" local://x.md`)).toBe(
			`omp read "$(cat /host/ref.txt)" local://x.md`,
		);
		expect(await host("2>/dev/null omp read local://x.md")).toBe("2>/dev/null omp read local://x.md");
		expect(await host("2> /dev/null omp read local://x.md")).toBe("2> /dev/null omp read local://x.md");
		expect(await host("2>&1 omp read local://x.md")).toBe("2>&1 omp read local://x.md");
		expect(await host("nice -n 5 2>/dev/null omp read local://x.md")).toBe(
			"nice -n 5 2>/dev/null omp read local://x.md",
		);
		expect(await host("2>local://err.log omp read local://x.md > local://out.txt")).toBe(
			"2>/host/err.log omp read local://x.md > /host/out.txt",
		);
		expect(await host("ssh host omp read local://x.md")).toBe("ssh host omp read /host/x.md");
	});

	it("keeps omp's URLs when it is the command a split-string option runs, and resolves a file-backed omp", async () => {
		const anyBacking: UrlBacking = async url => `/host/${url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "")}`;
		const hostAny = (command: string) => hostCommandUrls(command, anyBacking);
		expect(await hostAny("env -S omp read skill://tdd")).toBe("env -S omp read skill://tdd");
		expect(await hostAny("env --split-string omp read skill://tdd")).toBe("env --split-string omp read skill://tdd");
		expect(await hostAny("env -Somp read skill://tdd")).toBe("env -Somp read skill://tdd");
		expect(await hostAny("env -S grep omp skill://tdd")).toBe("env -S grep omp /host/tdd");
		expect(await hostAny("function f { omp read skill://tdd; }; f")).toBe("function f { omp read skill://tdd; }; f");
		expect(await hostAny("function f { cat skill://tdd; }; f")).toBe("function f { cat /host/tdd; }; f");
		expect(await hostAny("local://bin/omp --version")).toBe("/host/bin/omp --version");
		expect(await hostAny("local://bin/omp read local://x.md")).toBe("/host/bin/omp read local://x.md");
	});

	it("keeps omp's URLs when its path contains spaces or a line continuation precedes it", async () => {
		expect(await host("'/opt/My Tools/omp' read local://x.md:1")).toBe("'/opt/My Tools/omp' read local://x.md:1");
		expect(await host("nice -n 5 '/opt/My Tools/omp' read local://x.md:1")).toBe(
			"nice -n 5 '/opt/My Tools/omp' read local://x.md:1",
		);
		expect(await host("/opt/My\\ Tools/omp read local://x.md:1")).toBe("/opt/My\\ Tools/omp read local://x.md:1");
		expect(await host("'/opt/My Tools/grep' omp local://x.md")).toBe("'/opt/My Tools/grep' omp /host/x.md");
		expect(await host('env -S "/opt/My Tools/omp" read local://x.md')).toBe(
			'env -S "/opt/My Tools/omp" read /host/x.md',
		);

		expect(await host("REF=foo \\\nomp read local://x.md:1")).toBe("REF=foo \\\nomp read local://x.md:1");
		expect(await host("REF=foo \\\n omp read local://x.md:1")).toBe("REF=foo \\\n omp read local://x.md:1");
		expect(await host("nice \\\nomp read local://x.md:1")).toBe("nice \\\nomp read local://x.md:1");
		expect(await host("REF=foo \\\ngrep omp local://x.md")).toBe("REF=foo \\\ngrep omp /host/x.md");
	});

	it("resolves a file-backed omp whose path contains spaces and keeps its own URLs", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-spaced-"));
		try {
			const omp = path.join(dir, "My Tools", "omp");
			fs.mkdirSync(path.dirname(omp), { recursive: true });
			fs.writeFileSync(omp, "");
			const backing: UrlBacking = async url =>
				url === "local://My Tools/omp"
					? omp
					: url.startsWith("local://")
						? `/host/${url.slice("local://".length)}`
						: undefined;
			expect(await hostCommandUrls("nice 'local://My Tools/omp' read local://x.md", backing)).toBe(
				`nice '${omp}' read local://x.md`,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps omp's URLs behind env options, uv run options, an empty exec name, and coproc", async () => {
		const anyBacking: UrlBacking = async url => `/host/${url.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "")}`;
		const hostAny = (command: string) => hostCommandUrls(command, anyBacking);
		expect(await hostAny("env --chdir local://dir -S omp read skill://tdd")).toBe(
			"env --chdir /host/dir -S omp read skill://tdd",
		);
		expect(await hostAny("env --chdir /tmp -S grep omp skill://tdd")).toBe("env --chdir /tmp -S grep omp /host/tdd");
		expect(await hostAny("uv run --no-project --color never omp read skill://tdd")).toBe(
			"uv run --no-project --color never omp read skill://tdd",
		);
		expect(await hostAny("uv run --link-mode copy omp read skill://tdd")).toBe(
			"uv run --link-mode copy omp read skill://tdd",
		);
		expect(await hostAny("uv run --resolution lowest omp read skill://tdd")).toBe(
			"uv run --resolution lowest omp read skill://tdd",
		);
		expect(await hostAny("uv run --color never grep omp skill://tdd")).toBe(
			"uv run --color never grep omp /host/tdd",
		);
		expect(await hostAny("exec -a '' omp read skill://tdd")).toBe("exec -a '' omp read skill://tdd");
		expect(await hostAny("exec -a '' grep omp skill://tdd")).toBe("exec -a '' grep omp /host/tdd");
		expect(await hostAny("coproc omp read skill://tdd")).toBe("coproc omp read skill://tdd");
		expect(await hostAny("coproc { omp read skill://tdd; }")).toBe("coproc { omp read skill://tdd; }");
		expect(await hostAny("coproc NAME { omp read skill://tdd; }")).toBe("coproc NAME { omp read skill://tdd; }");
		expect(await hostAny("coproc NAME { cat skill://tdd; }")).toBe("coproc NAME { cat /host/tdd; }");
		expect(await hostAny("coproc grep omp skill://tdd")).toBe("coproc grep omp /host/tdd");
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

/** A UI whose `custom()` runs the pty console's factory on a headless 100×30 host and resolves with its result. */
function headlessUi(): InteractiveUi {
	const custom: InteractiveUi["custom"] = async (factory, _options) => {
		const { promise, resolve } = Promise.withResolvers<never>();
		await factory(
			{ requestRender() {}, size: () => ({ columns: 100, rows: 30 }), suspend: run => run() },
			extensionTheme(currentTheme()),
			KeybindingsManager.inMemory(),
			value => resolve(value as never),
		);
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
		const daemon: UnitSnapshot = {
			id: "web-1",
			kind: "proc",
			scope: { kind: "project", dir: tempDir },
			key: "web",
			label: "web",
			generation: "web-gen-1",
			state: "running",
			pids: [1],
			createdAt: 1,
			startedAt: 1,
			restartCount: 0,
			outputBytes: 0,
			owner: "bash-host-urls",
			leases: 1,
			policy: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
			supervised: true,
		};
		let started: ProcSpec | undefined;
		const client = {
			onCompletion: () => () => {},
			onNotify: () => () => {},
			onReconnect: () => () => {},
			close() {},
			async request(operation: { op: string; proc?: ProcSpec }) {
				if (operation.op === "open") {
					started = operation.proc;
					return { unit: daemon, lease: "lease-1", created: true };
				}
				if (operation.op === "logs") return { text: "", terminalOutput: "", cursor: 0, unit: daemon };
				throw new Error(`Unexpected daemon op ${operation.op}`);
			},
		} as unknown as DaemonClient;
		vi.spyOn(daemonClients, "daemonClient").mockResolvedValue(client);

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
		// What backs them is in the script the process sources, not on its command line.
		expect(args[args.indexOf(SHELL_PROCESS_SELECTOR) + 1]).toBe("--source");
		expect(await fs.promises.readFile(args[args.indexOf(SHELL_PROCESS_SELECTOR) + 2], "utf-8")).toContain(
			`urlmap 'local://' '${localRoot}'`,
		);
	});

	it.skipIf(ptyUnavailable)("runs a pty command on the files its URLs alias", async () => {
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
