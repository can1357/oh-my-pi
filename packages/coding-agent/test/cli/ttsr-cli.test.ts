import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	runTtsrCommand,
	TTSR_SOURCES,
	type TtsrCommandArgs,
	type TtsrScanArgs,
	type TtsrTestArgs,
} from "@oh-my-pi/pi-coding-agent/cli/ttsr-cli";
import { resetSettingsForTest } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getProjectAgentDir, getProjectDir, removeSyncWithRetries, setProjectDir } from "@oh-my-pi/pi-utils";

let testTmpDir: string;

beforeAll(() => {
	testTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ttsr-tests-"));
});

afterAll(() => {
	if (testTmpDir && fs.existsSync(testTmpDir)) {
		removeSyncWithRetries(testTmpDir);
	}
});

// Capture stdout writes so assertions don't leak to the test runner.
let stdout = "";

const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalExit = process.exit;
const originalExitCode = process.exitCode;

class ExitSignal extends Error {
	constructor(readonly code?: number) {
		super("exit");
		this.name = "ExitSignal";
	}
}

function captureStreams(): void {
	stdout = "";
	process.exitCode = 0;
	process.stdout.write = ((chunk: string | Uint8Array) => {
		// Strip ANSI so assertions match the rendered text rather than chalk's
		// color escapes; JSON output paths emit no color codes, so this is a
		// no-op for those tests.
		stdout += Bun.stripANSI(chunk.toString());
		return true;
	}) as typeof process.stdout.write;
	process.exit = ((code?: number) => {
		throw new ExitSignal(code);
	}) as typeof process.exit;
}

function restoreStreams(): void {
	process.stdout.write = originalStdoutWrite;
	process.exit = originalExit;
	process.exitCode = originalExitCode;
}

async function run(args: TtsrCommandArgs): Promise<void> {
	try {
		await runTtsrCommand(args);
	} catch (err) {
		if (!(err instanceof ExitSignal)) throw err;
	}
}

async function writeTempRule(
	condition: string,
	scope: string[],
	options: { astCondition?: string; agents?: string[] } = {},
): Promise<string> {
	// Stable basename "test-rule.md" so buildRuleFromMarkdown derives name
	// "test-rule" — assertions rely on it. Each call uses a unique parent dir
	// to avoid collisions across tests.
	const dir = path.join(testTmpDir, `rule-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, "test-rule.md");
	const fm: string[] = [`description: test rule`, `condition: "${condition.replace(/"/g, '\\"')}"`];
	if (options.astCondition) fm.push(`astCondition: "${options.astCondition.replace(/"/g, '\\"')}"`);
	fm.push(`scope: [${scope.map(s => `"${s}"`).join(", ")}]`);
	if (options.agents) fm.push(`agents: [${options.agents.map(a => `"${a}"`).join(", ")}]`);
	await Bun.write(tmp, `---\n${fm.join("\n")}\n---\nbody\n`);
	return tmp;
}

async function writeTempSnippet(content: string, ext: string): Promise<string> {
	const dir = path.join(testTmpDir, `snippet-${Math.random().toString(36).slice(2)}`);
	fs.mkdirSync(dir, { recursive: true });
	const tmp = path.join(dir, `snippet.${ext}`);
	await Bun.write(tmp, content);
	return tmp;
}

function cleanupTmp(): void {
	if (!testTmpDir || !fs.existsSync(testTmpDir)) return;
	for (const entry of fs.readdirSync(testTmpDir)) {
		removeSyncWithRetries(path.join(testTmpDir, entry));
	}
}

describe("omp ttsr", () => {
	afterEach(() => {
		restoreStreams();
		cleanupTmp();
	});

	describe("test — context inference and matching", () => {
		it("infers tool/edit context when a positional resolves to a .ts file and --source is omitted", async () => {
			captureStreams();
			const rulePath = await writeTempRule(": any", ["tool:edit(*.ts)"]);
			// Simulate `omp ttsr test --rule <rule> src/foo.ts`: the command layer
			// resolves a file positional into `file`, but the CLI handler's own
			// inference (source from file extension) is exercised when source is
			// unset. Pass file + filePath so the handler infers tool context.
			const snippetPath = await writeTempSnippet("const x: any = 1", "ts");
			const test: TtsrTestArgs = {
				rule: rulePath,
				file: snippetPath,
				source: undefined,
			};
			await run({ action: "test", test });
			expect(stdout).toContain("source=tool:edit");
			expect(stdout).toContain("Triggered");
			expect(stdout).toContain("test-rule");
		});

		it("defaults to source=text for inline snippet with no file", async () => {
			captureStreams();
			const rulePath = await writeTempRule(": any", ["tool:edit(*.ts)"]);
			const test: TtsrTestArgs = {
				rule: rulePath,
				snippet: "const x: any = 1",
				source: undefined,
			};
			await run({ action: "test", test });
			expect(stdout).toContain("source=text");
			// tool-scoped rule does not fire under text source
			expect(stdout).toContain("No rules triggered");
		});

		it("does not trigger a tool-scoped rule when --source text is explicit", async () => {
			captureStreams();
			const rulePath = await writeTempRule(": any", ["tool:edit(*.ts)"]);
			const test: TtsrTestArgs = {
				rule: rulePath,
				source: "text",
				snippet: "const x: any = 1",
			};
			await run({ action: "test", test });
			expect(stdout).toContain("No rules triggered");
		});

		it("reports JSON with matched/defined condition arrays", async () => {
			captureStreams();
			const rulePath = await writeTempRule(": any", ["tool:edit(*.ts)"]);
			const test: TtsrTestArgs = {
				rule: rulePath,
				source: "tool",
				filePath: "src/foo.ts",
				snippet: "const x: any = 1",
			};
			await run({ action: "test", test, json: true });
			const report = JSON.parse(stdout);
			expect(report.triggered).toHaveLength(1);
			expect(report.triggered[0].matched.regex).toContain(": any");
			expect(report.triggered[0].defined.regex).toContain(": any");
			expect(report.source).toBe("tool");
			expect(report.tool).toBe("edit");
		});

		it("astCondition matches via checkAstSnapshot with a tool + .ts path", async () => {
			captureStreams();
			const rulePath = await writeTempRule("never-matches-regex-zzz", ["tool:edit(*.ts)"], {
				astCondition: "($X as { $$$BODY }).$PROP",
			});
			const test: TtsrTestArgs = {
				rule: rulePath,
				source: "tool",
				filePath: "src/foo.ts",
				snippet: "const y = (x as { z }).z;",
			};
			await run({ action: "test", test });
			expect(stdout).toContain("Triggered");
			expect(stdout).toContain("astCondition");
		});

		it("infers tool/edit context for a newly-allowlisted .cs file", async () => {
			captureStreams();
			const rulePath = await writeTempRule("class", ["tool:edit(*.cs)"]);
			const snippetPath = await writeTempSnippet("class A {}", "cs");
			await run({ action: "test", test: { rule: rulePath, file: snippetPath, source: undefined }, json: true });
			const report = JSON.parse(stdout);
			expect(report.source).toBe("tool");
			expect(report.tool).toBe("edit");
			expect(report.triggered).toHaveLength(1);
			// A recognized source file needs no context-mismatch note.
			expect(report.inferenceNote).toBeUndefined();
		});

		it("emits an inference note when a supplied file path falls through to text source", async () => {
			captureStreams();
			const rulePath = await writeTempRule("class", ["tool:edit(*.cs)"]);
			const snippetPath = await writeTempSnippet("class A {}", "unknownext");
			await run({ action: "test", test: { rule: rulePath, file: snippetPath, source: undefined }, json: true });
			const report = JSON.parse(stdout);
			expect(report.source).toBe("text");
			expect(report.inferenceNote).toContain(".unknownext");
			expect(report.inferenceNote).toContain("--source tool --tool edit");
			// The tool-scoped rule is a false negative here — the note explains why.
			expect(report.triggered).toHaveLength(0);
		});

		it("renders the inferred text-source note in human-readable output", async () => {
			captureStreams();
			const rulePath = await writeTempRule("class", ["tool:edit(*.cs)"]);
			const snippetPath = await writeTempSnippet("class A {}", "unknownext");
			await run({ action: "test", test: { rule: rulePath, file: snippetPath, source: undefined } });
			expect(stdout).toContain("note: inferred --source text from '.unknownext'");
			expect(stdout).toContain("--source tool --tool edit");
		});

		it("omits the inference note when --source is explicit", async () => {
			captureStreams();
			const rulePath = await writeTempRule("class", ["tool:edit(*.cs)"]);
			const snippetPath = await writeTempSnippet("class A {}", "unknownext");
			await run({ action: "test", test: { rule: rulePath, file: snippetPath, source: "text" }, json: true });
			const report = JSON.parse(stdout);
			expect(report.inferenceNote).toBeUndefined();
		});

		it("triggers for a matching --agent and rejects for a non-matching one", async () => {
			captureStreams();
			const rulePath = await writeTempRule(": any", ["tool:edit(*.ts)"], { agents: ["scout"] });
			const test: TtsrTestArgs = {
				rule: rulePath,
				source: "tool",
				filePath: "src/foo.ts",
				snippet: "const x: any = 1",
				agent: "scout",
			};
			await run({ action: "test", test });
			expect(stdout).toContain("Triggered");
			expect(stdout).toContain("agents: scout");

			captureStreams();
			await run({ action: "test", test: { ...test, agent: "main" }, json: true });
			const report = JSON.parse(stdout);
			expect(report.error).toMatch(/scoped to agents/);
		});
	});

	describe("list", () => {
		it("emits a JSON array of rule objects with expected shape", async () => {
			captureStreams();
			await run({ action: "list", json: true });
			const arr = JSON.parse(stdout);
			expect(Array.isArray(arr)).toBe(true);
			// Assert structural shape only — the exact rule set depends on
			// user/project settings, which we don't isolate here.
			if (arr.length > 0) {
				const first = arr[0] as Record<string, unknown>;
				expect(first).toHaveProperty("name");
				expect(first).toHaveProperty("path");
				expect(first).toHaveProperty("condition");
				expect(first).toHaveProperty("astCondition");
				expect(first).toHaveProperty("scope");
			}
		});
	});

	describe("scan — directory scanning", () => {
		let originalCwd: string;

		beforeEach(() => {
			originalCwd = getProjectDir();
		});

		afterEach(() => {
			setProjectDir(originalCwd);
			resetSettingsForTest();
		});

		it("finds matching rules for files in directory matching rules globs/scopes", async () => {
			captureStreams();

			// 1. Create a temporary project root directory
			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });

			// 2. Set project root
			setProjectDir(projectDir);

			// 3. Create a test file in projectDir/src/foo.ts
			const testFile = path.join(projectDir, "src/foo.ts");
			await Bun.write(testFile, "const x: any = 1;");

			// 4. Create isolated rule with glob/scope
			const rulePath = await writeTempRule(": any", ["tool:edit(src/**/*.ts)"]);

			const scan: TtsrScanArgs = {
				directory: "src",
				rule: rulePath,
				verbose: true,
			};

			await run({ action: "scan", scan });

			expect(stdout).toContain("TTSR scan");
			expect(stdout).toContain("Found violations/matches");
			expect(stdout).toContain("src/foo.ts");
			expect(stdout).toContain("test-rule");
			expect(process.exitCode).toBeFalsy();
		});

		it("keeps default scan output summary-only", async () => {
			captureStreams();

			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
			setProjectDir(projectDir);

			await Bun.write(path.join(projectDir, "src/foo.ts"), "const x: any = 1;");

			const rulePath = await writeTempRule(": any", ["tool:edit(src/**/*.ts)"]);
			const scan: TtsrScanArgs = {
				directory: "src",
				rule: rulePath,
			};

			await run({ action: "scan", scan });

			expect(stdout).toContain("Found violations/matches");
			expect(stdout).toContain("rerun with --verbose");
			expect(stdout).not.toContain("src/foo.ts");
			expect(stdout).not.toContain("test-rule");
		});

		it("outputs json format correctly when json flag is set", async () => {
			captureStreams();

			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
			setProjectDir(projectDir);

			const testFile = path.join(projectDir, "src/foo.ts");
			await Bun.write(testFile, "const x: any = 1;");

			const rulePath = await writeTempRule(": any", ["tool:edit(src/**/*.ts)"]);

			const scan: TtsrScanArgs = {
				directory: "src",
				rule: rulePath,
			};

			await run({ action: "scan", scan, json: true });

			const result = JSON.parse(stdout);
			expect(result.files).toHaveLength(1);
			expect(result.files[0].filePath).toBe("src/foo.ts");
			expect(result.files[0].matches).toHaveLength(1);
			expect(result.files[0].matches[0].name).toBe("test-rule");
			expect(result.summary.totalMatches).toBe(1);
			expect(process.exitCode).toBeFalsy();
		});

		it("reports no matches when files do not match rule conditions", async () => {
			captureStreams();

			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
			setProjectDir(projectDir);

			const testFile = path.join(projectDir, "src/foo.ts");
			await Bun.write(testFile, "const x: unknown = 1;");

			const rulePath = await writeTempRule(": any", ["tool:edit(src/**/*.ts)"]);

			const scan: TtsrScanArgs = {
				directory: "src",
				rule: rulePath,
			};

			await run({ action: "scan", scan });

			expect(stdout).toContain("No rule matches found");
			expect(process.exitCode).toBeFalsy();
		});

		it("respects project gitignore when scanning a subdirectory", async () => {
			captureStreams();

			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
			fs.mkdirSync(path.join(projectDir, "packages/generated"), { recursive: true });
			fs.mkdirSync(path.join(projectDir, "packages/src"), { recursive: true });
			setProjectDir(projectDir);

			await Bun.write(path.join(projectDir, ".gitignore"), "packages/generated/\n");
			await Bun.write(path.join(projectDir, "packages/generated/ignored.ts"), "const x: any = 1;");
			await Bun.write(path.join(projectDir, "packages/src/kept.ts"), "const x: unknown = 1;");

			const rulePath = await writeTempRule(": any", ["tool:edit(packages/**/*.ts)"]);
			const scan: TtsrScanArgs = {
				directory: "packages",
				rule: rulePath,
			};

			await run({ action: "scan", scan, json: true });

			const result = JSON.parse(stdout);
			expect(result.files).toHaveLength(0);
			expect(result.summary.totalFiles).toBe(1);
			expect(result.summary.scannedFiles).toBe(1);
			expect(result.summary.totalMatches).toBe(0);
			expect(result.summary.gitignore).toBe(true);
		});

		it("honors ttsr.enabled=false for project scans", async () => {
			captureStreams();

			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
			fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
			setProjectDir(projectDir);

			await Bun.write(
				path.join(getProjectAgentDir(projectDir), "settings.json"),
				JSON.stringify({ ttsr: { enabled: false } }),
			);
			await Bun.write(path.join(projectDir, "src/foo.ts"), "const x: any = 1;");

			await run({ action: "scan", scan: { directory: "src" }, json: true });

			const result = JSON.parse(stdout);
			expect(result.error).toBe("No TTSR rules registered for this project.");
		});

		it("includes ignored files when gitignore filtering is disabled", async () => {
			captureStreams();

			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
			fs.mkdirSync(path.join(projectDir, "packages/generated"), { recursive: true });
			setProjectDir(projectDir);

			await Bun.write(path.join(projectDir, ".gitignore"), "packages/generated/\n");
			await Bun.write(path.join(projectDir, "packages/generated/ignored.ts"), "const x: any = 1;");

			const rulePath = await writeTempRule(": any", ["tool:edit(packages/**/*.ts)"]);
			const scan: TtsrScanArgs = {
				directory: "packages",
				rule: rulePath,
				gitignore: false,
			};

			await run({ action: "scan", scan, json: true });

			const result = JSON.parse(stdout);
			expect(result.files).toHaveLength(1);
			expect(result.files[0].filePath).toBe("packages/generated/ignored.ts");
			expect(result.summary.gitignore).toBe(false);
		});

		it("includes hidden source files like GitHub workflows", async () => {
			captureStreams();

			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, ".github/workflows"), { recursive: true });
			setProjectDir(projectDir);

			await Bun.write(path.join(projectDir, ".github/workflows/ci.yml"), "needs-ttsr: true\n");

			const rulePath = await writeTempRule("needs-ttsr", ["tool:edit(.github/**/*.yml)"]);
			const scan: TtsrScanArgs = {
				rule: rulePath,
			};

			await run({ action: "scan", scan, json: true });

			const result = JSON.parse(stdout);
			expect(result.files).toHaveLength(1);
			expect(result.files[0].filePath).toBe(".github/workflows/ci.yml");
			expect(result.summary.scannedFiles).toBe(1);
			expect(result.summary.totalMatches).toBe(1);
		});

		it("keeps AST-only matches in default summary when type assertion spans whitespace", async () => {
			captureStreams();

			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
			setProjectDir(projectDir);

			await Bun.write(path.join(projectDir, "src/foo.ts"), "const y = (x as\n{ z }).z;");
			const rulePath = await writeTempRule("never-matches-regex-zzz", ["tool:edit(src/**/*.ts)"], {
				astCondition: "($X as { $$$BODY }).$PROP",
			});
			const scan: TtsrScanArgs = {
				directory: "src",
				rule: rulePath,
			};

			await run({ action: "scan", scan });

			expect(stdout).toContain("Found violations/matches");
			expect(stdout).toContain("1 matches across 1 files");
			expect(stdout).not.toContain("src/foo.ts");
		});

		it("skips files larger than the scan byte limit", async () => {
			captureStreams();

			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
			setProjectDir(projectDir);

			await Bun.write(path.join(projectDir, "src/large.ts"), "const x: any = 1;");

			const rulePath = await writeTempRule(": any", ["tool:edit(src/**/*.ts)"]);
			const scan: TtsrScanArgs = {
				directory: "src",
				rule: rulePath,
				maxBytes: 4,
			};

			await run({ action: "scan", scan, json: true });

			const result = JSON.parse(stdout);
			expect(result.files).toHaveLength(0);
			expect(result.summary.totalFiles).toBe(1);
			expect(result.summary.scannedFiles).toBe(0);
			expect(result.summary.skipped.large).toBe(1);
			expect(result.summary.totalMatches).toBe(0);
			expect(result.summary.maxBytes).toBe(4);
		});

		it("skips binary-looking files before text matching", async () => {
			captureStreams();

			const projectDir = path.join(testTmpDir, `.tmp-ttsr-project-${Math.random().toString(36).slice(2)}`);
			fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
			setProjectDir(projectDir);

			await Bun.write(path.join(projectDir, "src/blob.ts"), new Uint8Array([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x00]));

			const rulePath = await writeTempRule("const", ["tool:edit(src/**/*.ts)"]);
			const scan: TtsrScanArgs = {
				directory: "src",
				rule: rulePath,
			};

			await run({ action: "scan", scan, json: true });

			const result = JSON.parse(stdout);
			expect(result.files).toHaveLength(0);
			expect(result.summary.totalFiles).toBe(1);
			expect(result.summary.scannedFiles).toBe(0);
			expect(result.summary.skipped.binary).toBe(1);
			expect(result.summary.totalMatches).toBe(0);
		});
	});

	describe("exports", () => {
		it("TTSR_SOURCES lists all three match sources", () => {
			expect(TTSR_SOURCES).toEqual(["text", "thinking", "tool"]);
		});
	});
});
