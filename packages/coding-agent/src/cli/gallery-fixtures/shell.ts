/** Gallery fixtures for the shell tools (bash, eval, launch). */
import type { GalleryFixture } from "./types";

export const shellFixtures: Record<string, GalleryFixture> = {
	bash: {
		label: "Bash",
		streamingArgs: {
			command: "git status --short && git log --on",
		},
		args: {
			command: "git status --short && git log --oneline -5",
			cwd: "packages/coding-agent",
			timeout: 30,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						" M src/cli/gallery-cli.ts",
						" M src/tools/bash.ts",
						"?? src/cli/gallery-fixtures/shell.ts",
						"a1b2c3d Wire gallery command into CLI dispatch",
						"9f8e7d6 Add ToolExecutionComponent lifecycle states",
						"4c5b6a7 Extract createShellRenderer from bashToolRenderer",
						"2d3e4f5 Strip LLM-facing notices before TUI render",
						"7a8b9c0 Cap preview lines in pending command block",
					].join("\n"),
				},
			],
			details: {
				exitCode: 0,
				wallTimeMs: 184,
				timeoutSeconds: 30,
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: [
						"src/tools/bash.ts:1142:34 - error TS2339: Property 'requestedTimeoutSeconds' does not exist on type 'BashToolDetails'.",
						"",
						"1142   const requestedTimeoutSeconds = details?.requestedTimeoutSeconds;",
						"                                            ~~~~~~~~~~~~~~~~~~~~~~~~",
						"Found 1 error in src/tools/bash.ts:1142",
					].join("\n"),
				},
			],
			isError: true,
			details: {
				exitCode: 2,
				wallTimeMs: 5120,
				timeoutSeconds: 30,
			},
		},
	},

	hub_start: {
		label: "Hub start",
		renderer: "hub",
		streamingArgs: { op: "start", name: "web" },
		args: {
			op: "start",
			name: "web",
			application: "bun",
			args: ["run", "dev"],
			ready: { log: "Local:.*http", port: 5173, timeout: 30 },
		},
		result: {
			content: [
				{
					type: "text",
					text: "Started web: ready pid=51234 uptime=1.2s restarts=0\nReady: Local: http://localhost:5173",
				},
			],
			details: {
				op: "start",
				daemon: {
					name: "web",
					id: "d-1",
					state: "ready",
					pid: 51234,
					createdAt: 0,
					startedAt: Date.now() - 1_200,
					readyAt: Date.now(),
					restartCount: 0,
					outputBytes: 2048,
					readyMatch: "Local:   http://localhost:5173/",
					persist: false,
					detached: false,
				},
				timedOut: false,
			},
		},
		errorResult: {
			content: [{ type: "text", text: "start requires application" }],
			isError: true,
			details: { op: "start" },
		},
	},

	hub_logs: {
		label: "Hub logs",
		renderer: "hub",
		args: { op: "logs", name: "comp-debug", lines: 100, follow: true, cursor: 233_512, timeout: 30 },
		result: {
			content: [
				{
					type: "text",
					text: [
						"Breakpoint 1: 3 locations.",
						"(lldb) run",
						"Process 726 launched: '/tmp/compiler'",
						"frame #0: 0x0000000100012f80 compiler`parse_expression",
						"[comp-debug: ready; cursor=233797]",
					].join("\n"),
				},
			],
			details: {
				op: "logs",
				cursor: 233_797,
				timedOut: false,
				state: "ready",
				terminalRows: [
					"\x1b[0mBreakpoint 1: 3 locations.",
					"\x1b[0m(lldb) run",
					"\x1b[0mProcess 726 launched: '/tmp/compiler'",
					"\x1b[0mframe #0: 0x0000000100012f80 compiler`parse_expression",
					"\x1b[0m\x1b[1;38;5;2m(lldb)\x1b[0m ",
				],
			},
		},
		errorResult: {
			content: [{ type: "text", text: "No daemon named web" }],
			isError: true,
			details: { op: "logs" },
		},
	},

	eval: {
		label: "Eval",
		streamingArgs: {
			language: "py",
			code: 'import json\nfrom pathlib import Path\n\ndata = json.loads(Path("package.js',
			title: "load config",
		},
		args: {
			language: "py",
			title: "load config",
			code: [
				"import json",
				"from pathlib import Path",
				"",
				'data = json.loads(Path("package.json").read_text())',
				'deps = data.get("dependencies", {})',
				'print(f"{data[\\"name\\"]} v{data[\\"version\\"]}")',
				'print(f"{len(deps)} dependencies")',
				"display(sorted(deps)[:3])",
			].join("\n"),
		},
		result: {
			content: [
				{
					type: "text",
					text: ["@oh-my-pi/coding-agent v0.42.0", "37 dependencies"].join("\n"),
				},
			],
			details: {
				language: "python",
				languages: ["python"],
				jsonOutputs: [["@ai-sdk/anthropic", "@oh-my-pi/pi-ai", "@oh-my-pi/pi-tui"]],
				cells: [
					{
						index: 0,
						title: "load config",
						language: "python",
						code: [
							"import json",
							"from pathlib import Path",
							"",
							'data = json.loads(Path("package.json").read_text())',
							'deps = data.get("dependencies", {})',
							'print(f"{data[\\"name\\"]} v{data[\\"version\\"]}")',
							'print(f"{len(deps)} dependencies")',
							"display(sorted(deps)[:3])",
						].join("\n"),
						output: ["@oh-my-pi/coding-agent v0.42.0", "37 dependencies"].join("\n"),
						status: "complete",
						durationMs: 64,
						exitCode: 0,
					},
				],
			},
		},
		errorResult: {
			content: [
				{
					type: "text",
					text: [
						"Traceback (most recent call last):",
						'  File "<cell 0>", line 4, in <module>',
						'    data = json.loads(Path("package.json").read_text())',
						"          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^",
						"json.decoder.JSONDecodeError: Expecting ',' delimiter: line 12 column 3 (char 318)",
					].join("\n"),
				},
			],
			isError: true,
			details: {
				language: "python",
				languages: ["python"],
				isError: true,
				cells: [
					{
						index: 0,
						title: "load config",
						language: "python",
						code: [
							"import json",
							"from pathlib import Path",
							"",
							'data = json.loads(Path("package.json").read_text())',
							'deps = data.get("dependencies", {})',
							'print(f"{data[\\"name\\"]} v{data[\\"version\\"]}")',
						].join("\n"),
						output: [
							"Traceback (most recent call last):",
							'  File "<cell 0>", line 4, in <module>',
							'    data = json.loads(Path("package.json").read_text())',
							"json.decoder.JSONDecodeError: Expecting ',' delimiter: line 12 column 3 (char 318)",
						].join("\n"),
						status: "error",
						durationMs: 41,
						exitCode: 1,
					},
				],
			},
		},
	},
};
