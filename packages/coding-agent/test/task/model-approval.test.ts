import { describe, expect, it } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { parseAgent } from "@oh-my-pi/pi-coding-agent/task/agents";
import {
	assertPerCallModelApproved,
	isPerCallModelApproved,
	type PerCallModelGrants,
} from "@oh-my-pi/pi-coding-agent/task/model-approval";
import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";

const target = createMockModel({ id: "target" });
const other = createMockModel({ id: "other" });
const bracketed = createMockModel({ id: "glm[1m]" });
const image = { ...createMockModel({ id: "painter" }), kind: "image" as const };
const chat = [target, other, bracketed];
const registry = {
	getAvailable: (kind?: string) => (kind === "chat" ? chat : [...chat, image]),
} as Parameters<typeof isPerCallModelApproved>[2];

interface Row {
	name: string;
	settings?: Record<string, unknown>;
	agentSource?: AgentSource;
	agentModel?: string[];
	agentRemoved?: boolean;
	parentModelPattern?: string;
	model?: Pick<Model, "provider" | "id">;
	approved: boolean;
}

const rows: Row[] = [
	{ name: "nothing configured", approved: false },
	{ name: "configured chat role value", settings: { modelRoles: { review: "mock/target" } }, approved: true },
	{ name: "role value with a level", settings: { modelRoles: { review: "mock/target:high" } }, approved: true },
	{
		name: "one candidate of a role list",
		settings: { modelRoles: { review: "mock/other,mock/target" } },
		approved: true,
	},
	{ name: "role value naming another model", settings: { modelRoles: { review: "mock/other" } }, approved: false },
	{ name: "glob role value", settings: { modelRoles: { review: "mock/*" } }, approved: true },
	{ name: "non-chat role value", settings: { modelRoles: { image: "mock/target" } }, approved: false },
	{ name: "role alias is not expanded into defaults", settings: { modelRoles: { review: "@smol" } }, approved: false },
	{ name: "bare * is @default, not a glob", settings: { modelRoles: { review: "*" } }, approved: false },
	{ name: "parent's live model", parentModelPattern: "mock/target", approved: true },
	{ name: "bundled agent frontmatter", agentSource: "bundled", agentModel: ["mock/target"], approved: true },
	{ name: "user agent frontmatter", agentSource: "user", agentModel: ["mock/target"], approved: true },
	{ name: "project agent frontmatter", agentSource: "project", agentModel: ["mock/target"], approved: false },
	{
		name: "removed agent's frontmatter",
		agentSource: "user",
		agentModel: ["mock/target"],
		agentRemoved: true,
		approved: false,
	},
	{
		name: "disabled agent's frontmatter",
		settings: { "task.disabledAgents": ["worker"] },
		agentSource: "user",
		agentModel: ["mock/target"],
		approved: false,
	},
	{
		name: "agent override entry is not a grant",
		settings: { "task.agentModelOverrides": { worker: "mock/target" } },
		approved: false,
	},
	{
		name: "retry fallback chain entry is not a grant",
		settings: { modelRoles: { review: "mock/other" }, "retry.fallbackChains": { review: ["mock/target"] } },
		approved: false,
	},
	{
		name: "allowlist narrows a granted model",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/other"] },
		approved: false,
	},
	{
		name: "allowlist admits a listed granted model",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/target"] },
		approved: true,
	},
	{ name: "allowlist alone grants nothing", settings: { "task.perCallModelAllow": ["mock/target"] }, approved: false },
	{
		name: "allowlist role entry admits what the role grants",
		settings: { modelRoles: { review: "mock/target", smol: "mock/other" }, "task.perCallModelAllow": ["@review"] },
		approved: true,
	},
	{
		name: "allowlist role entry excludes another role's model",
		settings: { modelRoles: { review: "mock/other", smol: "mock/target" }, "task.perCallModelAllow": ["@review"] },
		approved: false,
	},
	{
		name: "allowlist entry for an unconfigured role admits nothing",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["@smol"] },
		approved: false,
	},
	{
		name: "allowlist glob entry",
		settings: { modelRoles: { review: "mock/target" }, "task.perCallModelAllow": ["mock/t*"] },
		approved: true,
	},
	{
		name: "brackets in a literal id are not a glob",
		settings: { modelRoles: { review: "mock/glm[1m]" } },
		model: bracketed,
		approved: true,
	},
	{
		name: "a literal bracketed grant approves only itself",
		settings: { modelRoles: { review: "mock/glm[1m]" } },
		approved: false,
	},
	{
		name: "a non-chat model never qualifies",
		settings: { modelRoles: { review: "mock/*" } },
		model: image,
		approved: false,
	},
];

describe("per-call model grants", () => {
	it.each(rows)("$name", row => {
		const grants: PerCallModelGrants = {
			settings: Settings.isolated(row.settings ?? {}),
			agentName: "worker",
			agentSource: row.agentSource,
			agentModel: row.agentModel,
			agentRemoved: row.agentRemoved,
			parentModelPattern: row.parentModelPattern,
		};
		expect(isPerCallModelApproved(row.model ?? target, grants, registry)).toBe(row.approved);
	});

	it("never trusts a project agent file that claims a user source", () => {
		const agent = parseAgent(
			"/project/.omp/agents/worker.md",
			["---", "name: worker", "description: Worker", "source: user", "model: mock/target", "---", "Work."].join(
				"\n",
			),
			"project",
		);
		const grants = {
			settings: Settings.isolated(),
			agentName: agent.name,
			agentModel: agent.model,
			agentSource: agent.source,
		};
		expect(isPerCallModelApproved(target, grants, registry)).toBe(false);
	});

	it("names the allowlist in the rejection when one is set", () => {
		const grants = { settings: Settings.isolated({ "task.perCallModelAllow": ["mock/other"] }), agentName: "worker" };
		expect(() => assertPerCallModelApproved(target, grants, registry)).toThrow(/task\.perCallModelAllow/);
	});

	it.each([
		["a provider glob", ["openai/*"]],
		["a provider glob with a level", ["openai/*:high"]],
		["a role whose value is a provider glob", ["@scope"]],
	])("keeps %s in the allowlist on that provider", (_name, allow) => {
		const direct = createMockModel({ provider: "openai", id: "gpt-5" });
		const routed = createMockModel({ provider: "openrouter", id: "openai/gpt-5" });
		const providers = { getAvailable: () => [direct, routed] } as Parameters<typeof isPerCallModelApproved>[2];
		const settings = Settings.isolated({
			modelRoles: { review: "openrouter/openai/gpt-5", fast: "openai/gpt-5", scope: "openai/*" },
			"task.perCallModelAllow": allow,
		});
		const grants = { settings, agentName: "worker" };
		// Granted by `review`, but its bare id `openai/gpt-5` must not satisfy an `openai/*` entry.
		expect(isPerCallModelApproved(routed, grants, providers)).toBe(false);
		expect(isPerCallModelApproved(direct, grants, providers)).toBe(true);
	});
});
