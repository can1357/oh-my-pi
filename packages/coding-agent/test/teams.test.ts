import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	BUILTIN_TEAMS_SLASH_COMMANDS,
	resetTeamMembershipsForTests,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-teams";
import * as discovery from "@oh-my-pi/pi-coding-agent/task/discovery";
import { sanitizeAgentId } from "@oh-my-pi/pi-coding-agent/task/name-generator";
import * as spawnSubagent from "@oh-my-pi/pi-coding-agent/task/spawn-subagent";
import { withTeamIrcTools } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
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
	it("context names the handle, role, workspace, peers, and TASKS convention", async () => {
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
			expect(context).toContain("TASKS.md");
			expect(context).toContain("owner: Scout");
			expect(context).not.toContain("${member.handle}");
			expect(context).toContain("Teammates");
			expect(context).toContain("Reviewer (reviewer - Проверка находок)");
			expect(context).toContain("Общее пространство команды");
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
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
const TEAM_HANDLE = TEAM_COMMAND.handle as unknown as (command: { args: string }, runtime: unknown) => Promise<void>;

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

function mockTeamDiscovery(team: TeamDefinition): void {
	vi.spyOn(teamsModule, "discoverTeams").mockResolvedValue([team]);
	vi.spyOn(discovery, "discoverAgents").mockResolvedValue({
		agents: [{ name: "scout" }, { name: "reviewer" }],
	} as never);
}

function teamRuntime(root: string): { runtime: unknown; outputs: string[] } {
	const outputs: string[] = [];
	const runtime = {
		settings: Settings.isolated({ "team.enabled": true, "team.maxTeammates": 10 }),
		cwd: root,
		session: { effectiveExtensionRoots: undefined, toolSession: { getArtifactsDir: () => null } },
		sessionManager: { getCwd: () => root },
		output: (text: string) => {
			outputs.push(text);
		},
		refreshCommands: () => {},
		reloadPlugins: async () => {},
	};
	return { runtime, outputs };
}

describe("/team start and stop", () => {
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
			const spawn = vi
				.spyOn(spawnSubagent, "spawnSubagentForSession")
				.mockRejectedValue(new spawnSubagent.SpawnPendingError("Scout-pending"));
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
			await TEAM_HANDLE({ args: "stop audit" }, runtime);
			expect(release).toHaveBeenCalledWith("Scout-pending", ref, { tombstone: true });
		} finally {
			await cleanup();
		}
	});

	it("creates TASKS.md in the workspace and interpolates the owner handle", async () => {
		const { team, root, cleanup } = await teamFixture({ workspace: true, handles: ["Scout"] });
		try {
			mockTeamDiscovery(team);
			vi.spyOn(spawnSubagent, "spawnSubagentForSession").mockResolvedValue({ id: "Scout" } as never);
			const { runtime } = teamRuntime(root);
			const tasksPath = path.join(team.workspace!, "TASKS.md");

			await TEAM_HANDLE({ args: "start audit" }, runtime);
			expect(await fs.readFile(tasksPath, "utf8")).toContain("owner: <your-handle>");
			expect(renderTeamMemberContext(team, team.members[0]!)).toContain("owner: Scout");

			// Re-running start must not overwrite claims the team already made.
			await fs.writeFile(tasksPath, "claimed by Scout");
			resetTeamMembershipsForTests();
			await TEAM_HANDLE({ args: "start audit" }, runtime);
			expect(await fs.readFile(tasksPath, "utf8")).toBe("claimed by Scout");
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

describe("team-only IRC capability", () => {
	it("grants write to a read-only member only when teamIrc is set, leaving the definition untouched", () => {
		const readOnly: AgentDefinition = {
			name: "scout",
			description: "d",
			systemPrompt: "s",
			source: "bundled",
			tools: ["read", "grep"],
		};
		expect(withTeamIrcTools(readOnly, true).tools).toEqual(["read", "grep", "write"]);
		expect(withTeamIrcTools(readOnly, false)).toBe(readOnly);
		expect(withTeamIrcTools(readOnly, true, true)).toBe(readOnly);
		expect(readOnly.tools).toEqual(["read", "grep"]);
	});
});
