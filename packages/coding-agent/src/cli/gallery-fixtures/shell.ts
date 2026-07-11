/** Gallery fixtures for the shell tools (bash, eval). */
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
					text: ["@pk-nerdsaver-ai/coding-agent v0.42.0", "37 dependencies"].join("\n"),
				},
			],
			details: {
				language: "python",
				languages: ["python"],
				jsonOutputs: [["@ai-sdk/anthropic", "@pk-nerdsaver-ai/pi-ai", "@pk-nerdsaver-ai/pi-tui"]],
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
						output: ["@pk-nerdsaver-ai/coding-agent v0.42.0", "37 dependencies"].join("\n"),
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
