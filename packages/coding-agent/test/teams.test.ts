import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { prompt } from "@oh-my-pi/pi-utils";
import subagentTemplate from "../src/prompts/system/subagent-system-prompt.md" with { type: "text" };
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentRef, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	BUILTIN_TEAMS_SLASH_COMMANDS,
	resetTeamMembershipsForTests,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-teams";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { sanitizeAgentId } from "@oh-my-pi/pi-coding-agent/task/name-generator";
import * as spawnSubagent from "@oh-my-pi/pi-coding-agent/task/spawn-subagent";
import {
	releaseStructuredSubagentId,
	reserveStructuredSubagentId,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import {
	discoverTeams,
	parseTeamFile,
	renderTeamMemberContext,
	renderTeamMemberPrompt,
	resolveTeamMembers,
	sanitizeTeamHandle,
	UnknownTeamAgentError,
	type TeamDefinition,
} from "@oh-my-pi/pi-coding-agent/task/teams";
import * as teamsModule from "@oh-my-pi/pi-coding-agent/task/teams";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { teamRuntime as teamRuntimeState } from "@oh-my-pi/pi-coding-agent/task/team-runtime";
import { getTeamClient } from "@oh-my-pi/pi-coding-agent/thread/services/team-client";
import { registerLocalSession } from "@oh-my-pi/pi-coding-agent/thread/session-directory";

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
	AgentLifecycleManager.resetGlobalForTests();
	resetTeamMembershipsForTests();
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

	it("parses optional task titles in order and accepts an empty list", () => {
		const withTasks = TEAM_YAML.replace("members:", 'tasks: ["First", "Second"]\nmembers:');
		expect(parseTeamFile(withTasks, "/tmp/audit.md")?.tasks).toEqual(["First", "Second"]);
		expect(parseTeamFile(TEAM_YAML.replace("members:", "tasks: []\nmembers:"), "/tmp/audit.md")?.tasks).toEqual([]);
		expect(parseTeamFile(TEAM_YAML, "/tmp/audit.md")?.tasks).toBeUndefined();
	});

	it("rejects malformed task lists and entries", () => {
		for (const value of ["null", "a title", "42", "[first, 42]", '[""]', '["   "]', "[null]"]) {
			const contents = TEAM_YAML.replace("members:", `tasks: ${value}\nmembers:`);
			expect(parseTeamFile(contents, "/tmp/audit.md")).toBeUndefined();
		}
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
	it("context names the handle, role, workspace, peers, and task protocol", async () => {
		// A real temp dir keeps the workspace path platform-native: on Windows a
		// POSIX "/tmp/x" fixture resolves to a drive-lettered path, so the old
		// hardcoded expectation failed. Derive the expectation from the same root.
		const root = await tempDir();
		try {
			const team = parseTeamFile(TEAM_YAML, path.join(root, "audit.md"));
			const context = renderTeamMemberContext(team!, team!.members[0]!);
			expect(context).toContain("Your handle: Scout");
			expect(context).toContain("write agent://Scout");
			expect(context).toContain("Your role: Сбор логов и метаданных");
			expect(context).toContain(`Team workspace: ${path.join(root, "ws")}`);
			expect(context).toContain("read team://audit/tasks");
			expect(context).toContain("team://audit/tasks/<id>/claim");
			expect(context).toContain("team://audit/tasks/<id>/release");
			expect(context).toContain("team://audit/tasks/<id>/done");
			expect(context).not.toContain("owner: Scout");
			expect(context).toContain("Teammates");
			expect(context).toContain("Reviewer (reviewer - Проверка находок)");
			expect(context).toContain("Общее пространство команды");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("includes task protocol instructions without a workspace", () => {
		const team = parseTeamFile(TEAM_YAML.replace("workspace: ./ws\n", ""), "/tmp/audit.md")!;
		expect(renderTeamMemberContext(team, team.members[0]!)).toContain("read team://audit/tasks");
	});

	it("prompt is the team body plus the assignment when given", () => {
		const team = parseTeamFile(TEAM_YAML, "/tmp/x/audit.md");
		expect(renderTeamMemberPrompt(team!, undefined)).toBe("Инструкция команде: аудит охватывает сервисы X и Y.");
		expect(renderTeamMemberPrompt(team!, "сделай N")).toContain("Team assignment from the lead: сделай N");
	});
});

describe("sanitizeTeamHandle", () => {
	it("matches the registry's sanitizeAgentId exactly, including its 48-character cap", () => {
		expect(sanitizeTeamHandle("QA Tester")).toBe("QATester");
		expect(sanitizeTeamHandle("--x--")).toBe("--x--");
		expect(sanitizeTeamHandle("описание")).toBe("member");
		expect(sanitizeTeamHandle("dev_1")).toBe("dev_1");
		const long = "Long Handle ".repeat(6);
		expect(sanitizeTeamHandle(long)).toBe(sanitizeAgentId(long) ?? "");
		expect(sanitizeTeamHandle(long)).toHaveLength(48);
	});
});

describe("team subagent instructions", () => {
	it("directs team coordination to the actual lead without changing ordinary subagents", () => {
		const common = { agent: "role", ircSelfId: "worker", ircPeers: [], structured: true };
		const team = prompt.render(subagentTemplate, { ...common, team: true, teamLeadId: "Lead-2" });
		const ordinary = prompt.render(subagentTemplate, common);
		expect(team).toContain("Lead-2");
		expect(team).toContain("Message teammates and the lead directly");
		expect(team).not.toContain("NEVER send FYI");
		expect(team).toContain("Yield protocol");
		expect(ordinary).toContain("NEVER send FYI");
		expect(ordinary).not.toContain("Lead-2");
	});
});

describe("team handle through the spawn seam", () => {
	it("reserves the sanitized handle as the spawn id and passes the team workspace", async () => {
		const { spawnSubagentViaExecutor } = await import("@oh-my-pi/pi-coding-agent/task/spawn-subagent");
		const reserved: Array<{ label?: string }> = [];
		const runRequests: Array<{
			identity?: { id?: string };
			teamWorkspace?: string;
			context?: string;
			teamIrc?: boolean;
		}> = [];
		const handle = sanitizeTeamHandle("QA Tester");
		const executor = {
			reserveId: async (_session: unknown, identity: { label?: string } | undefined) => {
				reserved.push({ label: identity?.label });
				return sanitizeTeamHandle(identity?.label ?? "member");
			},
			run: async (request: {
				identity?: { id?: string };
				teamWorkspace?: string;
				context?: string;
				teamIrc?: boolean;
			}) => {
				runRequests.push(request);
				AgentRegistry.global().register({
					id: handle,
					displayName: handle,
					kind: "sub",
					session: null,
					status: "running",
				});
				return {
					result: {
						index: 0,
						id: handle,
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
			{ agent: "scout", prompt: "do it", handle: "QA Tester", teamWorkspace: "/tmp/ws", teamIrc: true },
			executor,
		);
		expect(reserved).toEqual([{ label: "QA Tester" }]);
		expect(runRequests[0]?.identity?.id).toBe(handle);
		expect(runRequests[0]?.teamWorkspace).toBe("/tmp/ws");
		expect(runRequests[0]?.context).toBeUndefined();
		expect(runRequests[0]?.teamIrc).toBe(true);
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

const TEAM_COMMAND = BUILTIN_TEAMS_SLASH_COMMANDS[0]!;
const TEAM_HANDLE = TEAM_COMMAND.handle as unknown as (command: { args: string }, runtime: unknown) => Promise<unknown>;

interface TeamFixture {
	team: TeamDefinition;
	root: string;
	cleanup: () => Promise<void>;
}

async function teamFixture(options: { workspace?: boolean; handles?: string[] } = {}): Promise<TeamFixture> {
	const root = await tempDir();
	const workspace = options.workspace === true ? path.join(root, "ws") : undefined;
	const handles = options.handles ?? ["Scout", "Reviewer"];
	const yaml = [
		"---",
		"name: audit",
		"description: audit team",
		...(workspace !== undefined ? [`workspace: ${JSON.stringify(workspace)}`] : []),
		"members:",
		...handles.flatMap(handle => ["  - agent: scout", `    handle: ${JSON.stringify(handle)}`]),
		"---",
		"Audit the services.",
	].join("\n");
	const team = parseTeamFile(yaml, path.join(root, "audit.md"));
	if (!team) throw new Error("team fixture did not parse");
	return { team, root, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

function mockTeamDiscovery(team: TeamDefinition, agents?: AgentDefinition[]): void {
	vi.spyOn(teamsModule, "discoverTeams").mockResolvedValue([team]);
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: agents ?? [
			{
				name: "scout",
				description: "Scout",
				systemPrompt: "Read-only scouting",
				teamSystemPrompt: "Coordinate scouting with the lead",
				source: "bundled",
				tools: ["read", "grep"],
			},
		],
	} as never);
}

function teamRuntime(root: string): { runtime: unknown; outputs: string[] } {
	const outputs: string[] = [];
	const runtime = {
		settings: Settings.isolated({ "team.enabled": true, "team.maxTeammates": 10 }),
		cwd: root,
		session: {
			instanceKey: `team-test:${crypto.randomUUID()}`,
			effectiveExtensionRoots: undefined,
			toolSession: { getArtifactsDir: () => null },
		},
		sessionManager: { getCwd: () => root },
		output: (text: string) => {
			outputs.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	registerLocalSession(runtime.session as unknown as AgentSession);
	AgentRegistry.global().register({
		id: "TeamLead",
		displayName: "TeamLead",
		kind: "main",
		session: runtime.session as unknown as AgentSession,
	});
	return { runtime, outputs };
}

describe("team startup lifecycle", () => {
	it("releases all new reservations when the team generation changes during startup", async () => {
		const { team, root, cleanup } = await teamFixture({ handles: ["Scout", "Reviewer", "Writer"] });
		try {
			mockTeamDiscovery(team);
			const spawn = vi.spyOn(spawnSubagent, "spawnSubagentForSession");
			const { runtime, outputs } = teamRuntime(root);
			const session = (runtime as { session: { toolSession: ToolSession } }).session;
			const client = getTeamClient();
			const members = client.members.bind(client);
			let reads = 0;
			vi.spyOn(client, "members").mockImplementation(async (key, name) => {
				if (++reads === 3) {
					await teamRuntimeState.stop(session, team.name);
					await teamRuntimeState.start(session, team);
				}
				return members(key, name);
			});

			expect(await TEAM_HANDLE({ args: "start audit" }, runtime)).toEqual({ consumed: true });
			expect(outputs).toContain("team: Team generation is no longer active");
			expect(spawn).not.toHaveBeenCalled();
			const fresh = { getArtifactsDir: () => null } as unknown as ToolSession;
			const scout = await reserveStructuredSubagentId(fresh, { label: "Scout" });
			const reviewer = await reserveStructuredSubagentId(fresh, { label: "Reviewer" });
			expect([scout, reviewer]).toEqual(["Scout", "Reviewer"]);
			releaseStructuredSubagentId(fresh, scout);
			releaseStructuredSubagentId(fresh, reviewer);
		} finally {
			await cleanup();
		}
	});
	it("abandons startup and frees reservations when membership updates keep conflicting", async () => {
		const { team, root, cleanup } = await teamFixture({ handles: ["Scout", "Reviewer"] });
		try {
			mockTeamDiscovery(team);
			const spawn = vi.spyOn(spawnSubagent, "spawnSubagentForSession");
			const { runtime, outputs } = teamRuntime(root);
			const session = (runtime as { session: { toolSession: ToolSession } }).session;
			const client = getTeamClient();
			const putMember = client.putMember.bind(client);
			const put = vi
				.spyOn(client, "putMember")
				.mockImplementation(async (...args) => (args[3] === "Reviewer" ? false : putMember(...args)));

			expect(await TEAM_HANDLE({ args: "start audit" }, runtime)).toEqual({ consumed: true });
			expect(outputs.join("\n")).toContain("team:");
			expect(outputs.join("\n")).toContain("Reviewer");
			expect(put.mock.calls.length).toBeGreaterThan(1);
			expect(put.mock.calls.length).toBeLessThan(100);
			expect(spawn).not.toHaveBeenCalled();
			expect(teamRuntimeState.members(session, team.name)?.size).toBe(0);
			const fresh = { getArtifactsDir: () => null } as unknown as ToolSession;
			const scout = await reserveStructuredSubagentId(fresh, { label: "Scout" });
			const reviewer = await reserveStructuredSubagentId(fresh, { label: "Reviewer" });
			expect([scout, reviewer]).toEqual(["Scout", "Reviewer"]);
			releaseStructuredSubagentId(fresh, scout);
			releaseStructuredSubagentId(fresh, reviewer);
		} finally {
			await cleanup();
		}
	});

	it("stops an empty generation after all spawns fail", async () => {
		const { team, root, cleanup } = await teamFixture({ handles: ["Scout"] });
		try {
			mockTeamDiscovery(team);
			vi.spyOn(spawnSubagent, "spawnSubagentForSession").mockRejectedValue(new Error("spawn failed"));
			const { runtime } = teamRuntime(root);
			await TEAM_HANDLE({ args: "start audit" }, runtime);
			await TEAM_HANDLE({ args: "stop audit" }, runtime);
			const session = (runtime as { session: object }).session;
			expect(teamRuntimeState.identity(session, "audit")).toBeUndefined();
		} finally {
			await cleanup();
		}
	});
});

describe("/team start and stop", () => {
	for (const definition of [
		{ name: "scout", tools: ["read"], team: undefined, reason: "read-only" },
		{ name: "scout", tools: [], team: undefined, reason: "read-only" },
		{ name: "scout", tools: ["write"], team: false, reason: "team: false" },
	]) {
		it(`rejects ${definition.reason} members without a team prompt before side effects`, async () => {
			const { team, root, cleanup } = await teamFixture({ workspace: true, handles: ["Scout"] });
			try {
				mockTeamDiscovery(team, [
					{
						...definition,
						description: "d",
						systemPrompt: "s",
						source: "project",
					},
				]);
				const spawn = vi.spyOn(spawnSubagent, "spawnSubagentForSession");
				const { runtime, outputs } = teamRuntime(root);
				await TEAM_HANDLE({ args: "start audit" }, runtime);
				expect(outputs.join("\n")).toContain("Scout");
				expect(outputs.join("\n")).toContain(definition.reason);
				if (definition.team === false) expect(outputs.join("\n")).not.toContain("read-only");
				expect(spawn).not.toHaveBeenCalled();
				expect(
					await fs.stat(team.workspace!).then(
						() => true,
						() => false,
					),
				).toBe(false);
				const session = (runtime as { session: { toolSession: ToolSession } }).session.toolSession;
				const id = await reserveStructuredSubagentId(session, { label: "Scout" });
				expect(id).toBe("Scout");
				releaseStructuredSubagentId(session, id);
			} finally {
				await cleanup();
			}
		});
	}

	for (const definition of [
		{ name: "scout", tools: ["write"] },
		{ name: "scout", tools: ["read"], team: false, teamSystemPrompt: "Coordinate with lead" },
	]) {
		it("starts compatible writable or explicitly team-prompted members", async () => {
			const { team, root, cleanup } = await teamFixture({ handles: ["Scout"] });
			try {
				mockTeamDiscovery(team, [
					{
						...definition,
						description: "d",
						systemPrompt: "s",
						source: "project",
					},
				]);
				const spawn = vi
					.spyOn(spawnSubagent, "spawnSubagentForSession")
					.mockResolvedValue({ id: "Scout" } as never);
				const { runtime } = teamRuntime(root);
				await TEAM_HANDLE({ args: "start audit" }, runtime);
				expect(spawn).toHaveBeenCalledTimes(1);
			} finally {
				await cleanup();
			}
		});
	}

	it("stop releases only the recorded member id, leaving an unrelated same-handle ref running", async () => {
		const { team, root, cleanup } = await teamFixture({ handles: ["Scout"] });
		try {
			mockTeamDiscovery(team);
			const release = vi.spyOn(AgentLifecycleManager.global(), "release").mockResolvedValue(true);
			const registry = AgentRegistry.global();
			registry.register({ id: "Scout", displayName: "Scout", kind: "sub", session: null, status: "running" });
			vi.spyOn(spawnSubagent, "spawnSubagentForSession").mockImplementation(async (_session, options) =>
				registry.register({ id: options.teamReservedId!, displayName: "member", kind: "sub", session: null }),
			);
			const { runtime } = teamRuntime(root);

			await TEAM_HANDLE({ args: "start audit" }, runtime);
			await TEAM_HANDLE({ args: "stop audit" }, runtime);

			expect(release.mock.calls.map(call => call[0])).toEqual(["Scout-2"]);
			expect(registry.get("Scout")?.status).toBe("running");
		} finally {
			await cleanup();
		}
	});

	it("does not release a replacement ref registered under a former member's id", async () => {
		const { team, root, cleanup } = await teamFixture({ handles: ["Scout"] });
		try {
			mockTeamDiscovery(team);
			const registry = AgentRegistry.global();
			vi.spyOn(spawnSubagent, "spawnSubagentForSession").mockImplementation(async (_session, options) =>
				registry.register({ id: options.teamReservedId!, displayName: "Scout", kind: "sub", session: null }),
			);
			const release = vi.spyOn(AgentLifecycleManager.global(), "release").mockResolvedValue(true);
			const { runtime } = teamRuntime(root);
			await TEAM_HANDLE({ args: "start audit" }, runtime);
			registry.register({ id: "Scout", displayName: "Other", kind: "sub", session: null });
			await TEAM_HANDLE({ args: "stop audit" }, runtime);
			expect(release).not.toHaveBeenCalled();
		} finally {
			await cleanup();
		}
	});

	it("does not report an unrelated same-handle ref as a team member", async () => {
		const { team, root, cleanup } = await teamFixture({ handles: ["Scout"] });
		try {
			mockTeamDiscovery(team);
			AgentRegistry.global().register({ id: "Scout", displayName: "Scout", kind: "sub", session: null });
			const { runtime, outputs } = teamRuntime(root);
			await TEAM_HANDLE({ args: "status audit" }, runtime);
			expect(outputs.at(-1)).toContain("not spawned");
		} finally {
			await cleanup();
		}
	});

	it("renders reserved peer IDs when handles collide with existing agents", async () => {
		const { team, root, cleanup } = await teamFixture({ handles: ["Scout", "Reviewer"] });
		try {
			mockTeamDiscovery(team);
			const registry = AgentRegistry.global();
			registry.register({ id: "Scout", displayName: "Other", kind: "sub", session: null });
			const spawn = vi
				.spyOn(spawnSubagent, "spawnSubagentForSession")
				.mockImplementation(async (_session, options) =>
					registry.register({
						id: options.teamReservedId!,
						displayName: options.handle!,
						kind: "sub",
						session: null,
					}),
				);
			const { runtime } = teamRuntime(root);
			await TEAM_HANDLE({ args: "start audit" }, runtime);
			expect(spawn.mock.calls[0]?.[1].context).toContain("Your handle: Scout-2");
			expect(spawn.mock.calls[1]?.[1].context).toContain("Scout-2 (scout");
			expect(spawn.mock.calls[0]?.[1].teamReservedId).toBe("Scout-2");
		} finally {
			await cleanup();
		}
	});

	it("reports a pending spawn by its reserved id and never marks it failed or re-spawns", async () => {
		const { team, root, cleanup } = await teamFixture({ handles: ["Scout"] });
		try {
			mockTeamDiscovery(team);
			const registration = Promise.withResolvers<AgentRef>();
			const spawn = vi
				.spyOn(spawnSubagent, "spawnSubagentForSession")
				.mockRejectedValue(new spawnSubagent.SpawnPendingError("Scout-pending", registration.promise));
			const { runtime, outputs } = teamRuntime(root);

			await TEAM_HANDLE({ args: "start audit" }, runtime);
			const first = outputs.join("\n");
			expect(first).toContain("Scout → pending (Scout-pending)");
			expect(first).not.toContain("FAILED");
			expect(first).toContain("Team is live");

			spawn.mockClear();
			await TEAM_HANDLE({ args: "start audit" }, runtime);
			expect(spawn).not.toHaveBeenCalled();
			expect(outputs.at(-1)).toContain("already running as Scout-pending");
			const release = vi.spyOn(AgentLifecycleManager.global(), "release").mockResolvedValue(true);
			await TEAM_HANDLE({ args: "stop audit" }, runtime);
			expect(outputs.at(-1)).toContain("retry stop after registration");
			const ref = AgentRegistry.global().register({
				id: "Scout-pending",
				displayName: "Scout",
				kind: "sub",
				session: null,
			});
			registration.resolve(ref);
			await registration.promise;
			await TEAM_HANDLE({ args: "stop audit" }, runtime);
			expect(release).toHaveBeenCalledWith("Scout-pending", ref, { tombstone: true });
		} finally {
			await cleanup();
		}
	});

	it("marks a pending member failed when its run ends unregistered, and starts it again", async () => {
		const { team, root, cleanup } = await teamFixture({ handles: ["Scout"] });
		try {
			mockTeamDiscovery(team);
			const registration = Promise.withResolvers<AgentRef>();
			const spawn = vi
				.spyOn(spawnSubagent, "spawnSubagentForSession")
				.mockRejectedValueOnce(new spawnSubagent.SpawnPendingError("Scout", registration.promise));
			const { runtime, outputs } = teamRuntime(root);

			await TEAM_HANDLE({ args: "start audit" }, runtime);
			registration.reject(new Error("model unavailable"));
			await registration.promise.catch(() => {});
			await TEAM_HANDLE({ args: "status audit" }, runtime);
			expect(outputs.at(-1)).toContain("failed: model unavailable");

			spawn.mockImplementation(async (_session, options) =>
				AgentRegistry.global().register({
					id: options.teamReservedId!,
					displayName: "Scout",
					kind: "sub",
					session: null,
				}),
			);
			await TEAM_HANDLE({ args: "start audit" }, runtime);
			expect(outputs.at(-1)).toContain("Scout → spawned (Scout-2)");
		} finally {
			await cleanup();
		}
	});

	it("reserves distinct ids for the same handle across sessions sharing a registry", async () => {
		const session = () => ({ getArtifactsDir: () => null }) as unknown as ToolSession;
		const first = session();
		const second = session();
		const [a, b] = await Promise.all([
			reserveStructuredSubagentId(first, { label: "Scout" }),
			reserveStructuredSubagentId(second, { label: "Scout" }),
		]);
		expect([a, b].sort()).toEqual(["Scout", "Scout-2"]);
		// A finished run frees its claim, so a fresh session can take the id again...
		releaseStructuredSubagentId(a === "Scout" ? first : second, "Scout");
		const third = session();
		expect(await reserveStructuredSubagentId(third, { label: "Scout" })).toBe("Scout");
		// ...but a registered ref keeps it taken once every claim is gone.
		releaseStructuredSubagentId(third, "Scout");
		AgentRegistry.global().register({ id: "Scout", displayName: "Scout", kind: "sub", session: null });
		expect(await reserveStructuredSubagentId(session(), { label: "Scout" })).not.toBe("Scout");
	});

	it("creates the generated task view and preserves the ledger across starts", async () => {
		const { team, root, cleanup } = await teamFixture({ workspace: true, handles: ["Scout"] });
		try {
			mockTeamDiscovery(team);
			vi.spyOn(spawnSubagent, "spawnSubagentForSession").mockResolvedValue({ id: "Scout" } as never);
			const { runtime } = teamRuntime(root);
			const tasksPath = path.join(team.workspace!, "TASKS.md");

			await TEAM_HANDLE({ args: "start audit" }, runtime);
			expect(await fs.readFile(tasksPath, "utf8")).toContain("# Team Tasks");
			expect(renderTeamMemberContext(team, team.members[0]!)).toContain("team://audit/tasks");
			const ledgerPath = path.join(team.workspace!, "tasks.json");
			expect(JSON.parse(await fs.readFile(ledgerPath, "utf8"))).toEqual([]);
			resetTeamMembershipsForTests();
			await TEAM_HANDLE({ args: "start audit" }, runtime);
			expect(JSON.parse(await fs.readFile(ledgerPath, "utf8"))).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	it("normalizes long/spaced handles to one registry id and grants team-only peer writes", async () => {
		const raw = "  QA Tester With A Very Long Name That Exceeds The Registry Cap By Quite A Lot  ";
		const normalized = sanitizeAgentId(raw) ?? "member";
		expect(normalized).toHaveLength(48);
		const { team, root, cleanup } = await teamFixture({ handles: [raw, "Reviewer"] });
		try {
			mockTeamDiscovery(team);
			const spawn = vi
				.spyOn(spawnSubagent, "spawnSubagentForSession")
				.mockResolvedValue({ id: normalized } as never);
			const { runtime } = teamRuntime(root);

			await TEAM_HANDLE({ args: "start audit" }, runtime);

			const options = spawn.mock.calls[0]?.[1];
			expect(options?.handle).toBe(normalized);
			expect(options?.teamIrc).toBe(true);
			const context = String(options?.context);
			expect(context).toContain(`Your handle: ${normalized}`);
			expect(context).toContain(`write agent://${normalized}`);
			expect(context).toContain("Reviewer (scout");
		} finally {
			await cleanup();
		}
	});
});
