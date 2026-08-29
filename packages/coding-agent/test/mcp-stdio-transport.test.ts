import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import { resolveStdioSpawnCommand, StdioTransport, writeFrame } from "@oh-my-pi/pi-coding-agent/mcp/transports/stdio";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

describe("resolveStdioSpawnCommand", () => {
	it("resolves bare Windows commands through PATHEXT and wraps .cmd shims with cmd.exe", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${shim}" serve --mcp"`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("prefers a project-local .cmd shim over a same-named global one when no path segment is given", async () => {
		const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-cwd-"));
		const globalDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-global-"));
		try {
			const localShim = path.join(projectDir, "server.cmd");
			const globalShim = path.join(globalDir, "server.cmd");
			await Bun.write(localShim, "@echo off\r\nrem local\r\n");
			await Bun.write(globalShim, "@echo off\r\nrem global\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "server.cmd", args: ["serve"] },
				{
					cwd: projectDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: globalDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${localShim}" serve"`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(projectDir);
			await removeWithRetries(globalDir);
		}
	});

	it("keeps PATH-resolved npx.cmd on the cmd.exe path so npm preserves stdio semantics", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-npx-"));
		try {
			const shim = path.join(tempDir, "npx.cmd");
			await Bun.write(
				shim,
				[
					"@ECHO off",
					"GOTO start",
					":find_dp0",
					"SET dp0=%~dp0",
					"EXIT /b",
					":start",
					"SETLOCAL",
					"CALL :find_dp0",
					"",
					'IF EXIST "%dp0%\\node.exe" (',
					'  SET "_prog=%dp0%\\node.exe"',
					") ELSE (",
					'  SET "_prog=node"',
					"  SET PATHEXT=%PATHEXT:;.JS;=;%",
					")",
					"",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\npm\\bin\\npx-cli.js" %*',
					"",
				].join("\r\n"),
			);

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "npx", args: ["-y", "mcp-gdb"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
					hostHasInheritableConsole: true,
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${shim}" -y mcp-gdb"`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(false);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("still launches non-npx npm .cmd shims through node so stdio stays owned by the server process", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-codegraph-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			const entry = path.join(tempDir, "node_modules", "@colbymchenry", "codegraph", "npm-shim.js");
			await Bun.write(
				shim,
				[
					"@ECHO off",
					"GOTO start",
					":find_dp0",
					"SET dp0=%~dp0",
					"EXIT /b",
					":start",
					"SETLOCAL",
					"CALL :find_dp0",
					"",
					'IF EXIST "%dp0%\\node.exe" (',
					'  SET "_prog=%dp0%\\node.exe"',
					") ELSE (",
					'  SET "_prog=node"',
					"  SET PATHEXT=%PATHEXT:;.JS;=;%",
					")",
					"",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\@colbymchenry\\codegraph\\npm-shim.js" %*',
					"",
				].join("\r\n"),
			);

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph.cmd", args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
					hostHasInheritableConsole: true,
				},
			);

			expect(result.cmd).toEqual(["node", entry, "serve", "--mcp"]);
			expect(result.windowsHide).toBe(false);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("keeps non-node cmd-shim wrappers on the cmd.exe path instead of mislaunching them via node", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-pyshim-"));
		try {
			const shim = path.join(tempDir, "pyserver.cmd");
			await Bun.write(
				shim,
				[
					"@ECHO off",
					"SETLOCAL",
					"CALL :find_dp0",
					"",
					'IF EXIST "%dp0%\\python.exe" (',
					'  SET "_prog=%dp0%\\python.exe"',
					") ELSE (",
					'  SET "_prog=python"',
					")",
					"",
					'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" "%dp0%\\node_modules\\pyserver\\cli.py" %*',
					"",
				].join("\r\n"),
			);

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "pyserver.cmd", args: ["serve"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${shim}" serve"`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("neutralizes percent-delimited args so cmd.exe cannot expand them before the .cmd shim", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-percent-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph", args: ["serve", "--header", "Authorization=%TOKEN%"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			// `%TOKEN%` -> `%%cd:~,%TOKEN%%cd:~,%`: `%cd:~,%` expands to nothing,
			// so cmd.exe leaves a literal `%TOKEN%` for the shim instead of
			// substituting an environment variable (BatBadBut / CVE-2024-24576).
			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${shim}" serve --header "Authorization=%%cd:~,%TOKEN%%cd:~,%""`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("doubles embedded quotes so cmd.exe delivers JSON args to the .cmd shim intact", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-quotes-"));
		try {
			const shim = path.join(tempDir, "codegraph.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: "codegraph", args: ["--config", '{"a":"b&c|d"}'] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: tempDir,
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${shim}" --config "{""a"":""b&c|d""}""`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("resolves extension-less absolute Windows paths to the sibling .cmd shim", async () => {
		// Mirrors npm's Windows shim layout: bare `codegraph` (shebang script),
		// `codegraph.cmd` (cmd.exe wrapper), and `codegraph.ps1` siblings under
		// %AppData%\Roaming\npm. uv_spawn rejects the extensionless script;
		// the resolver must promote the bare absolute path to its `.cmd`
		// sibling so the launch succeeds (see #2174). The test rig pins
		// PATHEXT to a single lowercase extension so the candidate filename
		// matches the file we create on the case-sensitive test host.
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-abs-"));
		try {
			const bare = path.join(tempDir, "codegraph");
			const shim = `${bare}.cmd`;
			await Bun.write(bare, "#!/bin/sh\n");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: bare, args: ["serve", "--mcp"] },
				{
					cwd: tempDir,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${shim}" serve --mcp"`,
			]);
			expect(result.windowsVerbatimArguments).toBe(true);
			expect(result.windowsHide).toBe(true);
			expect(result.detached).toBe(false);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("wraps explicit Windows .cmd commands in an escaped cmd.exe command line", async () => {
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "codegraph.cmd", args: ["serve", "--mcp"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "C:\\Users\\me\\AppData\\Roaming\\npm",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
			},
		);

		expect(result.cmd).toEqual([
			"C:\\Windows\\System32\\cmd.exe",
			"/d",
			"/e:ON",
			"/v:OFF",
			"/c",
			`""codegraph.cmd" serve --mcp"`,
		]);
		expect(result.windowsVerbatimArguments).toBe(true);
		expect(result.windowsHide).toBe(true);
		expect(result.detached).toBe(false);
	});

	it("routes unresolvable bare Windows commands through cmd.exe so PATHEXT can find a .cmd shim (#3250)", async () => {
		// Bun.spawn -> CreateProcess only appends `.exe` to extensionless names.
		// Commands shipped as `.cmd` shims (`npx`, `yarn`, most pnpm-installed
		// binaries on Windows) cannot be launched directly. When our PATH walk
		// finds nothing — empty PATH under a restricted parent, locked-down
		// shell, UNC mounts that reject `fs.access` — we must delegate to
		// cmd.exe so its native PATHEXT lookup runs. The legacy fallback
		// handed `Bun.spawn` the bare name and the subprocess died ~140ms
		// after spawn with ENOENT/EINVAL (issue #3250).
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "npx", args: ["-y", "cloakbrowser-mcp@latest"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
			},
		);

		expect(result.cmd).toEqual([
			"C:\\Windows\\System32\\cmd.exe",
			"/d",
			"/e:ON",
			"/v:OFF",
			"/c",
			`""npx" -y cloakbrowser-mcp@latest"`,
		]);
		expect(result.windowsVerbatimArguments).toBe(true);
		expect(result.windowsHide).toBe(true);
		expect(result.detached).toBe(false);
	});

	it("escapes command-injection payloads in .cmd shim args instead of leaving them live for cmd.exe", async () => {
		// BatBadBut / CVE-2024-24576: cmd.exe re-parses the /c string and
		// expands variables before the shim's argv split, so a crafted arg such
		// as `"&calc.exe` or `%CMDCMDLINE:~-1%&calc.exe` could break out and run
		// an attacker command. The escaped line MUST keep each `&` inside quotes
		// and split every `%` with `%cd:~,%` (which expands to nothing), so no
		// live `%VAR%` reference or bare `&calc.exe` reaches cmd.exe.
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "npx", args: ['"&calc.exe', "%CMDCMDLINE:~-1%&calc.exe"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
			},
		);

		const line = result.cmd.at(-1) ?? "";
		expect(line).toBe(`""npx" """&calc.exe" "%%cd:~,%CMDCMDLINE:~-1%%cd:~,%&calc.exe""`);
		// Every raw `%` is broken by an inserted `%cd:~,%`, so no substring
		// remains that cmd.exe would expand as `%…%` (the `~-1` extraction that
		// pulls a literal quote out of `%CMDCMDLINE%` can no longer fire).
		expect(line).not.toContain("%CMDCMDLINE:~-1%&");
		expect(line.split("&calc.exe").length - 1).toBe(2);
		expect(result.windowsVerbatimArguments).toBe(true);
	});

	it("rejects .cmd shim args containing characters that cannot round-trip through cmd.exe", async () => {
		for (const bad of ["a\0b", "a\rb", "a\nb"]) {
			await expect(
				resolveStdioSpawnCommand(
					{ type: "stdio", command: "npx", args: [bad] },
					{
						cwd: "C:\\project",
						env: {
							COMSPEC: "C:\\Windows\\System32\\cmd.exe",
							PATH: "",
							PATHEXT: ".COM;.EXE;.BAT;.CMD",
						},
						platform: "win32",
					},
				),
			).rejects.toThrow(/NUL, CR, or LF/);
		}
	});

	it("neutralizes percent syntax in the resolved .cmd path so cmd.exe launches the real shim", async () => {
		// A project/PATH directory can legally contain `%` on NTFS. cmd.exe
		// expands `%VAR%` across the whole /c string before launching the batch
		// file, so an un-escaped command token like C:\work\%TOKEN%\server.cmd
		// would resolve to a different path. The command token must be escaped
		// the same way arguments are.
		const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-cmdpct-"));
		const dir = path.join(base, "%TOKEN%");
		try {
			await fs.mkdir(dir, { recursive: true });
			const shim = path.join(dir, "server.cmd");
			await Bun.write(shim, "@echo off\r\n");

			const result = await resolveStdioSpawnCommand(
				{ type: "stdio", command: shim, args: ["serve"] },
				{
					cwd: base,
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: "",
						PATHEXT: ".cmd",
					},
					platform: "win32",
				},
			);

			const escapedShim = shim.replace("%TOKEN%", "%%cd:~,%TOKEN%%cd:~,%");
			expect(result.cmd).toEqual([
				"C:\\Windows\\System32\\cmd.exe",
				"/d",
				"/e:ON",
				"/v:OFF",
				"/c",
				`""${escapedShim}" serve"`,
			]);
			// No live `%TOKEN%` reference survives for cmd.exe to expand.
			expect(result.cmd.at(-1)).not.toContain(`${path.join(base, "%TOKEN%")}`);
			expect(result.windowsVerbatimArguments).toBe(true);
		} finally {
			await removeWithRetries(base);
		}
	});

	it("rejects a resolved .cmd command path containing characters that cannot round-trip through cmd.exe", async () => {
		await expect(
			resolveStdioSpawnCommand(
				{ type: "stdio", command: "C:\\work\\ser\rver.cmd", args: ["serve"] },
				{
					cwd: "C:\\project",
					env: {
						COMSPEC: "C:\\Windows\\System32\\cmd.exe",
						PATH: "",
						PATHEXT: ".COM;.EXE;.BAT;.CMD",
					},
					platform: "win32",
				},
			),
		).rejects.toThrow(/command cannot contain NUL, CR, or LF/);
	});

	it("leaves non-Windows commands untouched", async () => {
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "codegraph", args: ["serve", "--mcp"] },
			{ cwd: "/", env: {}, platform: "linux" },
		);

		expect(result.cmd).toEqual(["codegraph", "serve", "--mcp"]);
		expect(result.windowsHide).toBeUndefined();
		expect(result.detached).toBe(true);
	});

	it("keeps console-attached Windows cmd.exe wrapper chains out of CREATE_NO_WINDOW (#3567)", async () => {
		// The #3544 shape is `cmd.exe` → `node wrapper` → another console
		// launcher (`cmd.exe /C npx.cmd`, PowerShell, similar). If the OMP host
		// already owns a terminal console, `windowsHide: true` maps to
		// CREATE_NO_WINDOW and strips that inheritable console from the direct
		// hidden wrapper. Grandchildren then allocate fresh visible conhost
		// windows during startup or reconnect loops (#3567). Keep the tree
		// attached to OMP's console instead.
		const result = await resolveStdioSpawnCommand(
			{ type: "stdio", command: "cmd.exe", args: ["/C", "node .codex\\mcp-wrapper.js"] },
			{
				cwd: "C:\\project",
				env: {
					COMSPEC: "C:\\Windows\\System32\\cmd.exe",
					PATH: "",
					PATHEXT: ".COM;.EXE;.BAT;.CMD",
				},
				platform: "win32",
				hostHasInheritableConsole: true,
			},
		);

		expect(result.detached).toBe(false);
		expect(result.windowsHide).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// writeFrame — the seam that catches synchronous FileSink throws AND neutralizes
// asynchronous (Promise) rejections, so the async `notify` / `#sendResponse` /
// `request` paths never let an un-awaited broken-pipe rejection escape as a fatal
// unhandled rejection. See issue #1710 and its async follow-up.
// ---------------------------------------------------------------------------

describe("writeFrame", () => {
	it("writes and flushes, returning true on success", () => {
		const sink = {
			writes: [] as string[],
			flushed: 0,
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				this.flushed++;
			},
		};

		expect(writeFrame(sink, '{"k":1}\n')).toBe(true);
		expect(sink.writes).toEqual(['{"k":1}\n']);
		expect(sink.flushed).toBe(1);
	});

	it("returns false when write() throws synchronously (broken pipe)", () => {
		const sink = {
			flushed: 0,
			write() {
				throw new Error("EPIPE: broken pipe, write");
			},
			flush() {
				this.flushed++;
			},
		};

		expect(writeFrame(sink, "anything\n")).toBe(false);
		expect(sink.flushed).toBe(0);
	});

	it("returns false when flush() throws after a successful write", () => {
		const sink = {
			writes: [] as string[],
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				throw new Error("EPIPE: broken pipe, flush");
			},
		};

		expect(writeFrame(sink, "anything\n")).toBe(false);
		expect(sink.writes).toEqual(["anything\n"]);
	});

	it("does not propagate non-Error throws either", () => {
		const sink = {
			write() {
				throw "string-thrown-non-error";
			},
			flush() {},
		};

		expect(writeFrame(sink, "x")).toBe(false);
	});

	it("returns true and neutralizes an asynchronous write rejection (broken pipe surfaced as a Promise)", async () => {
		const sink = {
			flushed: 0,
			write() {
				return Promise.reject(new Error("EPIPE: broken pipe, write"));
			},
			flush() {
				this.flushed++;
			},
		};

		const tracker = trackUnhandled();
		try {
			// No synchronous throw, so the frame is "accepted"; the async rejection
			// must be neutralized rather than escaping as an unhandled rejection.
			expect(writeFrame(sink, "frame\n")).toBe(true);
			await Bun.sleep(50);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});

	it("returns true and neutralizes an asynchronous flush rejection", async () => {
		const sink = {
			writes: [] as string[],
			write(chunk: string) {
				this.writes.push(chunk);
			},
			flush() {
				return Promise.reject(new Error("EPIPE: broken pipe, flush"));
			},
		};

		const tracker = trackUnhandled();
		try {
			expect(writeFrame(sink, "frame\n")).toBe(true);
			await Bun.sleep(50);
			expect(tracker.capture()).toEqual([]);
		} finally {
			tracker.release();
		}
	});
});

// ---------------------------------------------------------------------------
// StdioTransport.notify — end-to-end behavior against a real subprocess that
// exits before or while a notification is sent. Contract defended here:
//
//   1. notify() always settles — no unhandled rejection ever escapes when
//      the underlying FileSink observes a closed pipe.
//   2. A failed write tears the transport down (`onClose` fires) and surfaces
//      a rejection to the caller when the platform reports one synchronously.
//
// On platforms where the pipe accepts the write, read-loop EOF still closes the
// transport. The request/response parsing path is covered separately; this test
// intentionally avoids requiring subprocess stdout because Bun's test runner can
// hand stdout-writing child processes an unusable fd on some hosts.
// ---------------------------------------------------------------------------

function trackUnhandled(): { release: () => unknown[]; capture: () => unknown[] } {
	const seen: unknown[] = [];
	const listener = (reason: unknown) => {
		seen.push(reason);
	};
	process.on("unhandledRejection", listener);
	return {
		release: () => {
			process.off("unhandledRejection", listener);
			return seen.slice();
		},
		capture: () => seen.slice(),
	};
}

describe("StdioTransport.notify", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("rejects synchronously when called before connect()", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});

		await expect(transport.notify("noop")).rejects.toThrow("Transport not connected");
	});

	it("rejects with 'Transport not connected' after close()", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});

		await transport.connect();
		await transport.close();

		await expect(transport.notify("noop")).rejects.toThrow("Transport not connected");
	});

	it("does not surface unhandled rejections when the subprocess exits before notify settles", async () => {
		const tracker = trackUnhandled();
		const closed = Promise.withResolvers<void>();
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});
		transport.onClose = () => {
			closed.resolve();
		};

		try {
			await transport.connect();
			const notify = transport.notify("notifications/initialized").catch((error: unknown) => {
				expect(error).toBeInstanceOf(Error);
			});

			await closed.promise;
			await notify;
			await Promise.resolve();

			expect(tracker.capture()).toEqual([]);
			expect(transport.connected).toBe(false);
		} finally {
			tracker.release();
		}
	});
});

describe("StdioTransport request failure diagnostics", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("reports abrupt subprocess termination as EOF instead of a generic close", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.stdin.once('data', () => process.exit(23)); process.stdin.resume()"],
			timeout: 1_000,
		});
		await transport.connect();
		const error = await transport.request("tools/list").then(
			() => undefined,
			reason => reason,
		);
		if (!(error instanceof MCPTransportError)) throw error;

		expect(error).toMatchObject({
			transport: "stdio",
			stage: "receive",
			failure: "eof",
			retryable: true,
		});
		expect(error.message).toContain("MCP subprocess");
	});

	it("reports malformed subprocess JSON at the decode stage", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.stdin.once('data', () => console.log('{not-json')); process.stdin.resume()"],
			timeout: 1_000,
		});
		await transport.connect();

		await expect(transport.request("tools/list")).rejects.toMatchObject({
			transport: "stdio",
			stage: "decode",
			failure: "malformed_response",
			retryable: false,
		});
	});
});

// ---------------------------------------------------------------------------
// StdioTransport.close — authoritative resource teardown that must keep
// cleaning up the subprocess and read loop even when `#handleClose()` has
// already flipped `#connected` (read-loop EOF, or a notify() write failure
// in the connectToServer() failure path). See PR #1711 follow-up.
//
// Bun's parent-side stdout reader only sees EOF when the subprocess
// actually exits, so the "subprocess closed its stdout but stayed alive"
// state we'd love to test directly cannot be reproduced through a real
// subprocess on this platform. Instead we exercise the post-handleClose
// code path via the natural read-loop-EOF route and pair it with explicit
// idempotency checks; the reviewer-flagged leak surfaces on Windows where
// the notify() write actually throws.
// ---------------------------------------------------------------------------

describe("StdioTransport.close", () => {
	let transport: StdioTransport | undefined;

	afterEach(async () => {
		await transport?.close().catch(() => {});
		transport = undefined;
	});

	it("completes cleanup when called after the read loop has already torn down", async () => {
		// Subprocess exits cleanly; the read loop sees EOF and fires
		// `#handleClose()`, flipping `#connected` to false. `close()` then
		// runs in exactly the state the reviewer flagged — `#connected`
		// already false, `#process` and `#readLoop` still set — and must
		// still null them out instead of early-returning.
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "process.exit(0)"],
		});

		let closeCount = 0;
		transport.onClose = () => {
			closeCount++;
		};

		await transport.connect();

		// Wait for the read loop to observe EOF and fire #handleClose.
		for (let i = 0; i < 100 && transport.connected; i++) {
			await Bun.sleep(10);
		}
		expect(transport.connected).toBe(false);
		expect(closeCount).toBe(1);

		// Must not throw and must not re-fire onClose.
		await transport.close();
		expect(closeCount).toBe(1);

		// Second close is a no-op too — every resource is already released.
		await transport.close();
		expect(closeCount).toBe(1);
	});

	it("is idempotent — repeat close() calls fire onClose exactly once", async () => {
		transport = new StdioTransport({
			type: "stdio",
			command: "bun",
			args: ["-e", "await Bun.sleep(60_000)"],
		});

		let closeCount = 0;
		transport.onClose = () => {
			closeCount++;
		};

		await transport.connect();
		await transport.close();
		await transport.close();
		await transport.close();

		expect(closeCount).toBe(1);
		expect(transport.connected).toBe(false);
	});

	// Regression for #5578: close() escalates SIGTERM to SIGKILL when the
	// subprocess ignores the former, so this must stay idempotent even when
	// the *first* close() had to run the full escalation path, not just the
	// already-covered "child exited before close()" and "child dies on plain
	// SIGTERM" cases above. POSIX-only: on Windows, `Subprocess.kill("SIGTERM")`
	// terminates the process immediately regardless of the handler, so the
	// child cannot trap it and the `elapsedMs >= 900` escalation-timing
	// assertion below would fail even though Windows `close()` behaves
	// correctly — same rationale as the `terminateStdioProcess` describe
	// block's platform skip in `stdio.test.ts`.
	it.skipIf(process.platform === "win32")(
		"is idempotent even when close() had to escalate to SIGKILL",
		async () => {
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mcp-stdio-close-escalate-"));
			const scriptPath = path.join(tempDir, "child.mjs");
			const readyPath = path.join(tempDir, "ready");
			try {
				await fs.writeFile(
					scriptPath,
					[
						"import { writeFileSync } from 'node:fs';",
						"process.on('SIGTERM', () => {});",
						`writeFileSync(${JSON.stringify(readyPath)}, '1');`,
						"setInterval(() => {}, 60_000);",
					].join("\n"),
				);
				transport = new StdioTransport({
					type: "stdio",
					command: "bun",
					args: ["run", scriptPath],
				});

				await transport.connect();

				// Wait for the child to actually register its SIGTERM handler before
				// closing: closing too early races the child's startup and hits the
				// default (terminate) action instead of exercising the escalation
				// path this test defends.
				for (let i = 0; i < 100; i++) {
					try {
						await fs.access(readyPath);
						break;
					} catch {
						await Bun.sleep(20);
					}
				}

				const started = performance.now();
				await transport.close();
				const elapsedMs = performance.now() - started;
				// Escalation only fires after the SIGTERM grace window elapses.
				expect(elapsedMs).toBeGreaterThanOrEqual(900);

				// Repeat close() calls must not throw or attempt to re-signal a
				// process the first call already tore down.
				await expect(transport.close()).resolves.toBeUndefined();
				await expect(transport.close()).resolves.toBeUndefined();
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true });
			}
		},
		5000,
	);
});
