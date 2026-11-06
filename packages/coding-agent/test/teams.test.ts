import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	discoverTeams,
	parseTeamFile,
	renderTeamMemberContext,
	renderTeamMemberPrompt,
	resolveTeamMembers,
	sanitizeTeamHandle,
	UnknownTeamAgentError,
} from "@oh-my-pi/pi-coding-agent/task/teams";

const TEAM_YAML = `---
name: audit
description: Команда аудита логов и отчёта
workspace: ./ws
members:
  - agent: scout
    handle: Scout
    role: Сбор логов и метаданных
  - agent: reviewer
    handle: Reviewer
    role: Проверка находок
context: |
  Общее пространство команды.
---
Инструкция команде: аудит охватывает сервисы X и Y.`;

async function tempDir(): Promise<string> {
	return fs.mkdtemp(path.join(os.tmpdir(), "omp-teams-"));
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("parseTeamFile", () => {
	it("parses frontmatter, members, workspace, context, and body", () => {
		const dir = "/tmp/x";
		const file = path.join(dir, "audit.md");
		const team = parseTeamFile(TEAM_YAML, file);
		expect(team).toBeDefined();
		expect(team?.name).toBe("audit");
		expect(team?.description).toBe("Команда аудита логов и отчёта");
		expect(team?.workspace).toBe(path.resolve(dir, "ws"));
		expect(team?.members).toHaveLength(2);
		expect(team?.members[0]).toMatchObject({ agent: "scout", handle: "Scout", role: "Сбор логов и метаданных" });
		expect(team?.context).toContain("Общее пространство");
		expect(team?.body).toContain("аудит охватывает");
	});

	it("skips a file with no name with undefined (warning logged)", () => {
		const team = parseTeamFile("---\ndescription: x\n---\nbody", "/tmp/bad.md");
		expect(team).toBeUndefined();
	});

	it("skips a file with no valid members", () => {
		const team = parseTeamFile("---\nname: t\ndescription: d\nmembers: []\n---\nbody", "/tmp/empty.md");
		expect(team).toBeUndefined();
	});

	it("skips member entries missing agent or handle", () => {
		const contents = `---
name: t
description: d
members:
  - handle: OnlyHandle
  - agent: onlyAgent
  - agent: scout
    handle: Good
---
body`;
		const team = parseTeamFile(contents, "/tmp/partial.md");
		expect(team?.members).toHaveLength(1);
		expect(team?.members[0]).toMatchObject({ agent: "scout", handle: "Good" });
	});
});

describe("discoverTeams", () => {
	it("discovers project teams first, first-wins by name across scopes", async () => {
		const root = await tempDir();
		try {
			const project = path.join(root, "proj", ".omp", "teams");
			await fs.mkdir(project, { recursive: true });
			await fs.writeFile(
				path.join(project, "audit.md"),
				"---\nname: audit\ndescription: project one\nmembers:\n  - agent: scout\n    handle: A\n---\nbody",
			);
			const teams = await discoverTeams(path.join(root, "proj"));
			expect(teams.map(team => team.name)).toEqual(["audit"]);
			expect(teams[0]?.description).toBe("project one");
			expect(teams[0]?.source).toBe("project");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("returns an empty list when no team files exist", async () => {
		const root = await tempDir();
		try {
			expect(await discoverTeams(root)).toEqual([]);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});
});

describe("resolveTeamMembers", () => {
	it("passes when every member agent resolves", () => {
		const team = parseTeamFile(TEAM_YAML, "/tmp/x/audit.md");
		expect(() => resolveTeamMembers(team!, [{ name: "scout" }, { name: "reviewer" }])).not.toThrow();
	});

	it("throws UnknownTeamAgentError listing available agents", () => {
		const team = parseTeamFile(TEAM_YAML, "/tmp/x/audit.md");
		expect(() => resolveTeamMembers(team!, [{ name: "scout" }])).toThrow(UnknownTeamAgentError);
		try {
			resolveTeamMembers(team!, [{ name: "scout" }]);
		} catch (error) {
			expect((error as Error).message).toContain("reviewer");
			expect((error as Error).message).toContain("Available agents: scout");
		}
	});
});

describe("render helpers", () => {
	it("context names the handle, role, workspace, peers, and TASKS convention", () => {
		const team = parseTeamFile(TEAM_YAML, "/tmp/x/audit.md");
		const context = renderTeamMemberContext(team!, team!.members[0]!);
		expect(context).toContain("Your handle: Scout");
		expect(context).toContain("write agent://Scout");
		expect(context).toContain("Your role: Сбор логов и метаданных");
		expect(context).toContain("Team workspace: /tmp/x/ws");
		expect(context).toContain("TASKS.md");
		expect(context).toContain("Teammates");
		expect(context).toContain("Reviewer (reviewer — Проверка находок)");
		expect(context).toContain("Общее пространство команды");
	});

	it("prompt is the team body plus the assignment when given", () => {
		const team = parseTeamFile(TEAM_YAML, "/tmp/x/audit.md");
		expect(renderTeamMemberPrompt(team!, undefined)).toBe("Инструкция команде: аудит охватывает сервисы X и Y.");
		expect(renderTeamMemberPrompt(team!, "сделай N")).toContain("Team assignment from the lead: сделай N");
	});
});

describe("sanitizeTeamHandle", () => {
	it("keeps alphanumerics, dashes, and underscores; trims junk; never empty", () => {
		expect(sanitizeTeamHandle("QA Tester")).toBe("QA-Tester");
		expect(sanitizeTeamHandle("--x--")).toBe("x");
		expect(sanitizeTeamHandle("описание")).toBe("member");
		expect(sanitizeTeamHandle("dev_1")).toBe("dev_1");
	});
});

describe("team handle through the spawn seam", () => {
	it("reserves the sanitized handle as the spawn id and passes the team workspace", async () => {
		const { spawnSubagentViaExecutor } = await import("@oh-my-pi/pi-coding-agent/task/spawn-subagent");
		const reserved: Array<{ label?: string }> = [];
		const runRequests: Array<{ teamWorkspace?: string; context?: string }> = [];
		const handle = "QA-Tester";
		const executor = {
			reserveId: async (_session: unknown, identity: { label?: string } | undefined) => {
				reserved.push({ label: identity?.label });
				return sanitizeTeamHandle(identity?.label ?? "member");
			},
			run: async (request: { teamWorkspace?: string; context?: string }) => {
				runRequests.push(request);
				AgentRegistry.global().register({
					id: "QA-Tester",
					displayName: handle,
					kind: "sub",
					session: null,
					status: "running",
				});
				return {
					result: {
						index: 0,
						id: "QA-Tester",
						agent: "scout",
						agentSource: "user",
						task: "do it",
						assignment: "do it",
						exitCode: 0,
						output: "ok",
						stderr: "",
						truncated: false,
						durationMs: 1,
						tokens: 0,
						requests: 1,
					},
					policy: { effectiveAgent: { name: "scout", description: "d", systemPrompt: "", source: "user" } },
					mergeSummary: "",
					changesApplied: null,
					artifactsDir: "/tmp",
					temporaryArtifacts: false,
				} as never;
			},
		};
		const session = {
			settings: Settings.isolated(),
			cwd: "/tmp",
			getArtifactsDir: () => null,
			getA2aBridge: () => undefined,
			getSessionSpawns: () => "*",
		} as never;
		await spawnSubagentViaExecutor(
			session,
			{ agent: "scout", prompt: "do it", handle: "QA Tester", teamWorkspace: "/tmp/ws" },
			executor,
		);
		expect(reserved).toEqual([{ label: "QA Tester" }]);
		expect(runRequests[0]?.teamWorkspace).toBe("/tmp/ws");
		expect(runRequests[0]?.context).toBeUndefined();
	});

	it("without a handle, behavior is unchanged (label = agent name, no workspace)", async () => {
		const { spawnSubagentViaExecutor } = await import("@oh-my-pi/pi-coding-agent/task/spawn-subagent");
		const reserved: Array<{ label?: string }> = [];
		const runRequests: Array<{ teamWorkspace?: string }> = [];
		const executor = {
			reserveId: async (_session: unknown, identity: { label?: string } | undefined) => {
				reserved.push({ label: identity?.label });
				return "scout";
			},
			run: async (request: { teamWorkspace?: string }) => {
				runRequests.push(request);
				AgentRegistry.global().register({
					id: "scout",
					displayName: "scout",
					kind: "sub",
					session: null,
					status: "running",
				});
				return {
					result: {
						index: 0,
						id: "QA-Tester",
						agent: "scout",
						agentSource: "user",
						task: "do it",
						assignment: "do it",
						exitCode: 0,
						output: "ok",
						stderr: "",
						truncated: false,
						durationMs: 1,
						tokens: 0,
						requests: 1,
					},
					policy: { effectiveAgent: { name: "scout", description: "d", systemPrompt: "", source: "user" } },
					mergeSummary: "",
					changesApplied: null,
					artifactsDir: "/tmp",
					temporaryArtifacts: false,
				} as never;
			},
		};
		const session = {
			settings: Settings.isolated(),
			cwd: "/tmp",
			getArtifactsDir: () => null,
			getA2aBridge: () => undefined,
			getSessionSpawns: () => "*",
		} as never;
		await spawnSubagentViaExecutor(session, { agent: "scout", prompt: "do it" }, executor);
		expect(reserved).toEqual([{ label: "scout" }]);
		expect(runRequests[0]?.teamWorkspace).toBeUndefined();
	});
});
