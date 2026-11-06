import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { GithubTool } from "@oh-my-pi/pi-coding-agent/tools/gh";
import { WriteTool } from "@oh-my-pi/pi-coding-agent/tools/write";
import { resolveXdevTool, type XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import type { ForgeCliResult } from "@oh-my-pi/pi-coding-agent/utils/forge-cli";
import { github } from "@oh-my-pi/pi-coding-agent/utils/github";
import * as themeModule from "@oh-my-pi/pi-tui/theme";
import { githubToolRenderer } from "@oh-my-pi/pi-tui/tools/github";
import { writeToolRenderer } from "@oh-my-pi/pi-tui/tools/write";
import { removeWithRetries } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "../helpers/mock-scheduler-clock";

const tempDirs: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});

async function createSession(): Promise<ToolSession> {
	const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gh-output-"));
	tempDirs.push(cwd);
	return {
		cwd,
		hasUI: false,
		settings: Settings.isolated({ "github.enabled": true }),
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getArtifactsDir: () => cwd,
		allocateOutputArtifact: async () => ({ id: "captured", path: path.join(cwd, "captured.github.log") }),
	};
}

const capturedLog: ForgeCliResult = { exitCode: 0, stdout: "first log line\nCAPTURED_LOG", stderr: "" };
const unavailableLog: ForgeCliResult = {
	exitCode: 7,
	stdout: "NOT_A_CAPTURED_LOG",
	stderr: `gh: HTTP 403: log access denied ${"界".repeat(10_000)} OMITTED_ERROR_SUFFIX`,
};
interface WatchCase {
	name: string;
	logs: ForgeCliResult[];
	label: string;
	reason?: string;
}
const watchCases: WatchCase[] = [
	{
		name: "labels all-unavailable logs as diagnostics and keeps a bounded fetch failure",
		logs: [unavailableLog],
		label: "Failed-job log diagnostics",
		reason: "exit code 7",
	},
	{
		name: "labels captured logs as full only when every failed job has log content",
		logs: [capturedLog, { ...capturedLog, stdout: "other first line\nSECOND_CAPTURED_LOG" }],
		label: "Full failed-job logs",
	},
	{
		name: "labels a single truncated capture as partial instead of full",
		logs: [{ ...capturedLog, stdoutTruncated: true }],
		label: "Partial failed-job logs",
	},
	{
		name: "labels all-available logs as partial when one capture is truncated",
		logs: [capturedLog, { ...capturedLog, stdoutTruncated: true }],
		label: "Partial failed-job logs",
	},
	{
		name: "labels partial logs and names the failed job whose log fetch failed",
		logs: [capturedLog, unavailableLog],
		label: "Partial failed-job logs",
		reason: "exit code 7",
	},
	{
		name: "does not claim full logs for a successful fetch with empty output",
		logs: [{ exitCode: 0, stdout: "\n\t\n", stderr: "" }],
		label: "Failed-job log diagnostics",
		reason: "empty",
	},
	{
		name: "keeps the failed fetch exit status even when stderr is empty",
		logs: [{ exitCode: 5, stdout: "", stderr: "" }],
		label: "Failed-job log diagnostics",
		reason: "exit code 5",
	},
];

for (const mode of ["run", "commit"] as const) {
	describe(`run_watch ${mode} log artifacts`, () => {
		for (const fixture of watchCases) {
			it(fixture.name, async () => {
				mockSchedulerWaitWithClock();
				const session = await createSession();
				const run = {
					id: 77,
					name: "CI",
					status: "completed",
					conclusion: "failure",
					head_branch: "main",
					head_sha: "0123456789abcdef",
					html_url: "https://github.com/owner/repo/actions/runs/77",
				};
				const jobs = fixture.logs.map((_log, index) => ({
					id: 201 + index,
					name: `failed-job-${201 + index}`,
					status: "completed",
					conclusion: "failure",
				}));
				const runSpy = vi.spyOn(github, "run").mockImplementation(async (_cwd, args) => {
					const endpoint = args.find(arg => arg.startsWith("/repos/"));
					const jobMatch = endpoint?.match(/\/actions\/jobs\/(\d+)\/logs$/);
					if (jobMatch) return fixture.logs[Number(jobMatch[1]) - 201];
					let data: unknown;
					switch (endpoint) {
						case "/repos/owner/repo/branches/main":
							data = { commit: { sha: run.head_sha } };
							break;
						case "/repos/owner/repo/actions/runs":
							data = { workflow_runs: [run] };
							break;
						case "/repos/owner/repo/actions/runs/77":
							data = run;
							break;
						case "/repos/owner/repo/actions/runs/77/jobs":
							data = { total_count: jobs.length, jobs };
							break;
						default:
							throw new Error(`Unexpected gh command: ${args.join(" ")}`);
					}
					return { exitCode: 0, stdout: JSON.stringify(data), stderr: "" };
				});

				const result = await new GithubTool(session).execute("watch-output", {
					op: "run_watch",
					repo: "owner/repo",
					...(mode === "run" ? { run: "77" } : { branch: "main" }),
					tail: 1,
				});
				const text = result.content.find(block => block.type === "text")?.text ?? "";
				const artifact = await Bun.file(path.join(session.cwd, "captured.github.log")).text();
				expect(text).toContain(`${fixture.label}: artifact://captured`);
				if (fixture.label !== "Full failed-job logs") expect(text).not.toContain("Full failed-job logs:");
				expect(result.details?.watch?.mode).toBe(mode);
				expect(result.details?.watch?.state).toBe("completed");
				for (const [index, log] of fixture.logs.entries()) {
					const failedLog = result.details?.watch?.failedLogs?.[index];
					const available = log.exitCode === 0 && log.stdout.trim().length > 0;
					expect(failedLog?.available).toBe(available);
					expect(text).toContain(jobs[index].name);
					expect(artifact).toContain(jobs[index].name);
					if (available) {
						expect(artifact).toContain(log.stdout);
						if (log.stdoutTruncated) {
							expect(artifact).toContain("Partial log (capture truncated):");
							expect(text).toContain("log capture truncated");
						} else {
							expect(artifact).toContain("Full log:");
						}
						expect(text).not.toContain(log.stdout.split("\n")[0]);
					} else {
						expect(text).toContain(fixture.reason!);
						expect(artifact).toContain(fixture.reason!);
						expect(JSON.stringify(failedLog)).toContain(fixture.reason!);
						if (log.stderr) {
							expect(text).toContain("HTTP 403: log access denied");
							expect(Buffer.byteLength(JSON.stringify(failedLog))).toBeLessThan(1024);
						}
					}
				}
				if (fixture.label === "Failed-job log diagnostics") expect(artifact).not.toContain("Full log:");
				for (const output of [text, artifact, JSON.stringify(result.details)]) {
					expect(output).not.toContain("NOT_A_CAPTURED_LOG");
					expect(output).not.toContain("OMITTED_ERROR_SUFFIX");
				}
				if (fixture.logs[0] === unavailableLog) {
					await themeModule.initTheme();
					const theme = await themeModule.getThemeByName("dark");
					if (!theme) throw new Error("expected an initialized theme");
					const options = { expanded: true, isPartial: false };
					const component = githubToolRenderer.renderResult(result, options, theme);
					expect(Bun.stripANSI(component.render(120).join("\n"))).toContain("exit code 7");
					expect(JSON.stringify(githubToolRenderer.describeResult(result, options))).toContain("exit code 7");
				}
				expect(
					runSpy.mock.calls.filter(([, args]) => args.some(arg => /\/actions\/jobs\/\d+\/logs$/.test(arg))),
				).toHaveLength(fixture.logs.length);
			});
		}
	});
}

it("keeps multiline gh stderr on one terminal diagnostic row", async () => {
	const session = await createSession();
	vi.spyOn(github, "json")
		.mockResolvedValueOnce({ id: 77, status: "completed", conclusion: "failure" })
		.mockResolvedValueOnce({
			total_count: 1,
			jobs: [{ id: 201, name: "failed-job-201", status: "completed", conclusion: "failure" }],
		});
	vi.spyOn(github, "run").mockResolvedValue({
		exitCode: 7,
		stdout: "",
		stderr: "first line\nsecond line\r\nthird\tline\u001b[31m\u0007\u001b[0m",
	});
	const result = await new GithubTool(session).execute("watch-multiline", {
		op: "run_watch",
		repo: "owner/repo",
		run: "77",
	});
	await themeModule.initTheme();
	const theme = await themeModule.getThemeByName("dark");
	if (!theme) throw new Error("expected an initialized theme");
	const options = { expanded: true, isPartial: false };
	const rows = githubToolRenderer.renderResult(result, options, theme).render(200);
	expect(rows.every(row => !/[\r\n\u0007]/.test(row))).toBe(true);
	const diagnosticRow = rows.map(row => Bun.stripANSI(row)).find(row => row.includes("log tail unavailable"));
	expect(diagnosticRow).toContain("first line second line third");
	expect(diagnosticRow).toContain("exit code 7");
	const described = JSON.stringify(githubToolRenderer.describeResult(result, options));
	expect(described).toContain("first line second line third");
});

describe("pr_create concise output", () => {
	for (const route of ["direct", "xd"] as const) {
		for (const summaryAvailable of [true, false]) {
			it(`${route} preserves the creation body without echoing it when the summary lookup ${summaryAvailable ? "succeeds" : "fails"}`, async () => {
				const session = await createSession();
				const body = "SENTINEL".repeat(6656);
				const input = {
					op: "pr_create" as const,
					repo: "owner/repo",
					title: "Add gizmo",
					body,
					base: "main",
					head: "feature/gizmo",
					draft: true,
				};
				let submittedBody: string | undefined;
				let requestedFields: string[] = [];
				const runSpy = vi.spyOn(github, "run").mockImplementation(async (_cwd, args) => {
					if (args[0] === "pr" && args[1] === "create") {
						const bodyFlagIndex = args.indexOf("--body-file");
						expect(bodyFlagIndex).toBeGreaterThanOrEqual(0);
						submittedBody = await Bun.file(args[bodyFlagIndex + 1]).text();
						return { exitCode: 0, stdout: "https://github.com/owner/repo/pull/77", stderr: "" };
					}
					if (args[0] !== "pr" || args[1] !== "view") {
						throw new Error(`Unexpected gh command: ${args.join(" ")}`);
					}
					requestedFields = args[args.indexOf("--json") + 1].split(",");
					if (!summaryAvailable) return { exitCode: 1, stdout: "", stderr: "summary lookup unavailable" };
					return {
						exitCode: 0,
						stderr: "",
						stdout: JSON.stringify({
							number: 77,
							url: "https://github.com/owner/repo/pull/77",
							title: input.title,
							state: "OPEN",
							isDraft: true,
							headRefName: input.head,
							baseRefName: input.base,
							body,
						}),
					};
				});
				const tool = Object.assign(new GithubTool(session), githubToolRenderer);
				const xdev: XdevState = {
					tools: new Map([[tool.name, tool]]),
					mountedNames: new Set([tool.name]),
					builtInNames: new Set([tool.name]),
					isActive: () => false,
					resolve: name => resolveXdevTool(xdev, name),
				};
				session.xdev = xdev;
				const result =
					route === "direct"
						? await tool.execute("create-output", input)
						: await new WriteTool(session).execute("create-output", {
								path: "xd://github",
								content: JSON.stringify(input),
							});
				expect(submittedBody).toBe(body);
				expect(input.body).toBe(body);
				expect(runSpy).toHaveBeenCalledTimes(2);
				const text = result.content.find(block => block.type === "text")?.text ?? "";
				expect(result.isError).not.toBe(true);
				expect(text).toContain("# Created Pull Request #77: Add gizmo");
				expect(text).toContain("URL: https://github.com/owner/repo/pull/77");
				expect(text).toContain("Head: feature/gizmo");
				expect(text).toContain("Base: main");
				expect(text).toContain("Draft: true");
				if (summaryAvailable) expect(text).toContain("State: OPEN");
				expect(text).not.toContain("## Body");
				expect(JSON.stringify(result)).not.toContain("SENTINEL");
				expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(2048);
				for (const field of ["body", "files", "comments", "reviews", "reviewComments"]) {
					expect(requestedFields).not.toContain(field);
				}
				if (route === "xd") {
					await themeModule.initTheme();
					const theme = await themeModule.getThemeByName("dark");
					if (!theme) throw new Error("expected an initialized theme");
					const rebuilt: typeof result = JSON.parse(JSON.stringify(result));
					// Result rebuilds must work from the projected dispatch, without
					// recovering the original body-bearing write arguments.
					const options = {
						expanded: true,
						isPartial: false,
						renderContext: { resolveXdevMounted: xdev.resolve },
					};
					const rendered = writeToolRenderer.renderResult(rebuilt, options, theme);
					const output = Bun.stripANSI(rendered.render(120).join("\n"));
					expect(output).toContain("owner/repo");
					expect(output).toContain("Created Pull Request #77: Add gizmo");
					expect(output).toContain("https://github.com/owner/repo/pull/77");
					expect(output).not.toContain("SENTINEL");
					const described = JSON.stringify(writeToolRenderer.describeResult?.(rebuilt, options));
					expect(described).toContain("owner/repo");
					expect(described).toContain("Created Pull Request #77: Add gizmo");
					expect(described).not.toContain("SENTINEL");
				}
			});
		}
	}

	it("retains renderer arguments for other GitHub operations", async () => {
		const session = await createSession();
		vi.spyOn(github, "run").mockResolvedValue({ exitCode: 0, stdout: '{"items":[]}', stderr: "" });
		const tool = new GithubTool(session);
		const xdev: XdevState = {
			tools: new Map([[tool.name, tool]]),
			mountedNames: new Set([tool.name]),
			builtInNames: new Set([tool.name]),
			isActive: () => false,
			resolve: name => resolveXdevTool(xdev, name),
		};
		session.xdev = xdev;
		const input = { op: "search_prs", query: "is:open", repo: "owner/repo" };
		const result = await new WriteTool(session).execute("other-output", {
			path: "xd://github",
			content: JSON.stringify(input),
		});
		expect(result.details?.xdev?.args).toEqual(input);
	});
});
