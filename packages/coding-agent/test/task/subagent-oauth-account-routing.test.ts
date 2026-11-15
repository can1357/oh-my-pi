/**
 * Task subagents on a multi-account Anthropic OAuth pool, end to end: a real parent
 * `createAgentSession` spawns through its real `task` tool into a real child session —
 * on the main thread and in a pooled worker thread — and every request reaches a fake
 * Anthropic server that answers by OAuth bearer token. A child must send its requests
 * on the parent's account pin, and, when that account hits its Claude usage limit,
 * block it and finish the same run on a sibling with quota, never retrying the
 * exhausted account.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import type { Model, OAuthCredential, UsageReport } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { __resetDirsFromEnvForTests, removeWithRetries } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { IrcBus } from "../../src/irc/bus";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { createAgentSession } from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AgentStorage } from "../../src/session/agent-storage";
import { AuthStorage, SqliteAuthCredentialStore } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import * as discoveryModule from "../../src/task/discovery";
import type { AgentDefinition } from "../../src/task/types";
import { SubagentWorkerPool, setSubagentWorkerPoolForTests } from "../../src/thread/subagent-worker";

const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
const MODEL_ID = "claude-sonnet-4-5";
const TEST_TIMEOUT_MS = 120_000;
/** In the child agent's system prompt only, so the server can tell the child's turns apart. */
const CHILD_MARKER = `omp-test-child-${Bun.randomUUIDv7("hex")}`;
const PARENT_PROVIDER_SESSION = "parent-provider-session";
const ACCOUNTS = ["a", "b", "c", "d"] as const;
type Account = (typeof ACCOUNTS)[number];
/**
 * Pool row order. The account with the most headroom (A) is neither the first nor the
 * last row, so first-entry or last-entry selection cannot pass for usage ranking.
 */
const STORED_ORDER: readonly Account[] = ["c", "a", "b", "d"];
/** Usage before any request: A has the most headroom, so unpinned ranking picks A, never B. */
const INITIAL_USED: Record<Account, number> = { a: 0.1, b: 0.4, c: 0.6, d: 0.8 };
const RETRY_AFTER_SECONDS = 20_520;

const CHILD_AGENT: AgentDefinition = {
	name: "task",
	description: "OAuth routing test agent",
	systemPrompt: `Do the assigned work (${CHILD_MARKER}).`,
	source: "bundled",
	tools: ["read"],
};

function accessToken(account: Account): string {
	return `sk-ant-oat01-test-${account}`;
}

function oauthCredential(account: Account): OAuthCredential {
	return {
		type: "oauth",
		access: accessToken(account),
		refresh: `refresh-${account}`,
		expires: Date.now() + 60 * 60_000,
		accountId: `account-${account}`,
		email: `${account}@example.com`,
	};
}

function claudeUsage(accountId: string, usedFraction: number): UsageReport {
	const used = usedFraction * 100;
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		metadata: { accountId },
		limits: [
			{
				id: "anthropic:5h",
				label: "Claude 5 Hour",
				scope: { provider: "anthropic", windowId: "5h", shared: true },
				window: {
					id: "5h",
					label: "Claude 5 Hour",
					durationMs: 5 * 60 * 60_000,
					resetsAt: Date.now() + RETRY_AFTER_SECONDS * 1000,
				},
				amount: {
					unit: "percent",
					used,
					limit: 100,
					remaining: 100 - used,
					usedFraction,
					remainingFraction: 1 - usedFraction,
				},
				status: usedFraction >= 1 ? "exhausted" : "ok",
			},
		],
	};
}

interface ClaudeRow {
	window: "5h" | "7d" | "7d:fable";
	used: number;
	resetsInMs: number;
}

/** A Claude usage report with exactly the given rows, shaped like the parsed `/api/oauth/usage` response. */
function claudeRows(accountId: string, rows: readonly ClaudeRow[]): UsageReport {
	return {
		provider: "anthropic",
		fetchedAt: Date.now(),
		metadata: { accountId },
		limits: rows.map(row => {
			const windowId = row.window === "5h" ? "5h" : "7d";
			const durationMs = (windowId === "5h" ? 5 : 7 * 24) * 60 * 60_000;
			const used = row.used * 100;
			return {
				id: `anthropic:${row.window}`,
				label: `Claude ${row.window}`,
				scope:
					row.window === "7d:fable"
						? { provider: "anthropic", windowId, tier: "fable" }
						: { provider: "anthropic", windowId, shared: true },
				window: { id: windowId, label: windowId, durationMs, resetsAt: Date.now() + row.resetsInMs },
				amount: {
					unit: "percent",
					used,
					limit: 100,
					remaining: 100 - used,
					usedFraction: row.used,
					remainingFraction: 1 - row.used,
				},
				status: row.used >= 1 ? "exhausted" : "ok",
			};
		}),
	};
}

interface RecordedRequest {
	account: Account;
	status: number;
}

/**
 * Who sent a Messages request: the child's own turns (its system prompt carries
 * {@link CHILD_MARKER}), the parent's tool-bearing turns, or a tool-less side request
 * (title, summary) from either session.
 */
type RequestOrigin = "child" | "parent" | "side";

interface RecordedAttempt extends RecordedRequest {
	origin: RequestOrigin;
}

function sse(events: ReadonlyArray<Record<string, unknown> & { type: string }>): string {
	return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function messageStart(): Record<string, unknown> & { type: string } {
	return {
		type: "message_start",
		message: {
			id: `msg_${Bun.randomUUIDv7("hex")}`,
			type: "message",
			role: "assistant",
			model: MODEL_ID,
			content: [],
			stop_reason: null,
			usage: { input_tokens: 8, output_tokens: 0 },
		},
	};
}

function textReply(text: string): string {
	return sse([
		messageStart(),
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}

function toolReply(name: string, input: Record<string, unknown>): string {
	return sse([
		messageStart(),
		{
			type: "content_block_start",
			index: 0,
			content_block: { type: "tool_use", id: `toolu_${Bun.randomUUIDv7("hex")}`, name, input: {} },
		},
		{
			type: "content_block_delta",
			index: 0,
			delta: { type: "input_json_delta", partial_json: JSON.stringify(input) },
		},
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]);
}

function textOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (!Array.isArray(value)) return "";
	return value
		.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
		.join("\n");
}

/**
 * Anthropic Messages API keyed by OAuth bearer token. An account in {@link exhausted}
 * answers every request with a Claude usage-limit 429; the others answer the child's
 * turns (yield, then prose) and every other request with prose. Records the child's
 * requests and the parent's own tool-bearing turns (side requests carry no tools).
 */
class FakeAnthropicServer {
	readonly #server: Bun.Server<undefined>;
	readonly exhausted = new Set<Account>();
	readonly childRequests: RecordedRequest[] = [];
	readonly parentRequests: RecordedRequest[] = [];
	/** Every Messages request in arrival order, tagged by origin: each one can block an account and rotate. */
	readonly attempts: RecordedAttempt[] = [];
	readonly used: Record<Account, number> = { ...INITIAL_USED };
	/** Usage rows an account's report carries in place of the single 5h window from {@link used}. */
	readonly reports = new Map<Account, readonly ClaudeRow[]>();

	constructor() {
		this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#fetch(request) });
	}

	get port(): number {
		return this.#server.port ?? 0;
	}

	stop(): void {
		this.#server.stop(true);
	}

	async #fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET") {
			return Response.json({
				data: [{ id: MODEL_ID, type: "model", display_name: "Fake", created_at: "2025-09-29T00:00:00Z" }],
				has_more: false,
			});
		}
		if (!url.pathname.endsWith("/v1/messages")) return new Response("not found", { status: 404 });
		const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
		const account = ACCOUNTS.find(candidate => accessToken(candidate) === bearer);
		if (!account) return Response.json({ type: "error", error: { type: "authentication_error" } }, { status: 401 });
		const body = (await request.json()) as {
			system?: unknown;
			messages?: Array<{ role: string; content: unknown }>;
			tools?: Array<{ name: string }>;
		};
		const isChild = textOf(body.system).includes(CHILD_MARKER);
		const isParentTurn = !isChild && (body.tools?.length ?? 0) > 0;
		const record = (status: number): void => {
			this.attempts.push({ origin: isChild ? "child" : isParentTurn ? "parent" : "side", account, status });
			if (isChild) this.childRequests.push({ account, status });
			else if (isParentTurn) this.parentRequests.push({ account, status });
		};
		if (this.exhausted.has(account)) {
			record(429);
			return Response.json(
				{
					type: "error",
					error: {
						type: "rate_limit_error",
						message: "This request would exceed your account's rate limit. Please try again later.",
					},
				},
				{ status: 429, headers: { "retry-after": String(RETRY_AFTER_SECONDS) } },
			);
		}
		record(200);
		if (!isChild) return new Response(textReply("parent ok"), { headers: { "content-type": "text/event-stream" } });
		const last = body.messages?.at(-1);
		const answeredTool =
			Array.isArray(last?.content) &&
			last.content.some(part => typeof part === "object" && part !== null && part.type === "tool_result");
		const yieldTool = body.tools?.find(tool => tool.name.endsWith("yield"));
		const reply =
			yieldTool && !answeredTool
				? toolReply(yieldTool.name, { type: "result", data: `child done on ${account}` })
				: textReply(`child done on ${account}`);
		return new Response(reply, { headers: { "content-type": "text/event-stream" } });
	}
}

function setEnv(key: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[key];
		delete Bun.env[key];
	} else {
		process.env[key] = value;
		Bun.env[key] = value;
	}
}

let root: string;
let cwd: string;
let agentDir: string;
let savedEnv: Record<string, string | undefined> = {};
let server: FakeAnthropicServer;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;
let model: Model;
const credentialIds = new Map<Account, number>();
const sessions: AgentSession[] = [];
let pool: SubagentWorkerPool | undefined;

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-subagent-oauth-"));
	const home = path.join(root, "home");
	agentDir = path.join(home, ".omp", "agent");
	cwd = path.join(home, "work");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(cwd, { recursive: true });
	// Workers read these at start-up, so set them before a pool spawns any.
	setEnv("HOME", home);
	setEnv("PI_CODING_AGENT_DIR", agentDir);
	setEnv("OMP_PROFILE", undefined);
	setEnv("PI_PROFILE", undefined);
	__resetDirsFromEnvForTests();
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({ agents: [CHILD_AGENT], projectAgentsDir: null });

	server = new FakeAnthropicServer();
	const modelsPath = path.join(agentDir, "models.yml");
	await Bun.write(modelsPath, `providers:\n  anthropic:\n    baseUrl: http://127.0.0.1:${server.port}\n`);
	authStorage = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")), {
		usageProviderResolver: provider =>
			provider === "anthropic"
				? {
						id: "anthropic",
						async fetchUsage({ credential }) {
							const account = ACCOUNTS.find(candidate => credential.accountId === `account-${candidate}`);
							if (!account) return null;
							const rows = server.reports.get(account);
							return rows
								? claudeRows(`account-${account}`, rows)
								: claudeUsage(`account-${account}`, server.used[account]);
						},
					}
				: undefined,
	});
	await authStorage.credentials.set(
		"anthropic",
		STORED_ORDER.map(account => oauthCredential(account)),
	);
	credentialIds.clear();
	for (const summary of authStorage.oauth.accounts("anthropic")) {
		const account = ACCOUNTS.find(candidate => summary.accountId === `account-${candidate}`);
		if (account) credentialIds.set(account, summary.credentialId);
	}
	modelRegistry = new ModelRegistry(authStorage, modelsPath);
	await modelRegistry.refresh();
	const found = modelRegistry.find("anthropic", MODEL_ID);
	if (!found) throw new Error("anthropic model missing from the registry");
	model = found;
});

afterEach(async () => {
	try {
		try {
			for (const session of sessions.splice(0).reverse()) await session.dispose();
			await AgentLifecycleManager.global().dispose();
		} finally {
			setSubagentWorkerPoolForTests(undefined);
			pool?.dispose();
			pool = undefined;
			AgentLifecycleManager.resetGlobalForTests();
			AgentRegistry.resetGlobalForTests();
			IrcBus.resetGlobalForTests();
			vi.restoreAllMocks();
			authStorage.close();
			AgentStorage.close();
			closeModelCache();
		}
	} finally {
		server.stop();
		for (const key of ENV_KEYS) setEnv(key, savedEnv[key]);
		__resetDirsFromEnvForTests();
		await removeWithRetries(root);
	}
});

function credentialId(account: Account): number {
	const id = credentialIds.get(account);
	if (id === undefined) throw new Error(`account ${account} not stored`);
	return id;
}

function testSettings(modelId = MODEL_ID): Settings {
	return Settings.isolated({
		"async.enabled": false,
		"compaction.enabled": false,
		"task.batch": true,
		"task.isolation.enabled": false,
		"task.agentIdleTtlMs": 0,
		"task.completionProbe": false,
		"todo.enabled": false,
		"todo.reminders": false,
		"advisor.enabled": false,
		// Bun's os.homedir() ignores the HOME override, so a worker child would discover the
		// host's own skills and spend side requests compressing their descriptions.
		"skills.enabled": false,
		"retry.baseDelayMs": 1,
		modelRoles: { default: `anthropic/${modelId}` },
	});
}

async function createParent(toolNames: string[], sessionModel: Model = model): Promise<AgentSession> {
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
		authStorage,
		modelRegistry,
		settings: testSettings(sessionModel.id),
		model: sessionModel,
		providerSessionId: PARENT_PROVIDER_SESSION,
		toolNames,
		disableExtensionDiscovery: true,
	});
	sessions.push(session);
	return session;
}

/** Spawn one child through the parent's real `task` tool and return its result row. */
async function runChild(parent: AgentSession): Promise<SingleResult> {
	const task = parent.getToolByName("task");
	if (!task) throw new Error("parent has no task tool");
	const result = await task.execute("task-call", {
		context: "Exercise OAuth routing.",
		tasks: [{ agent: "task", name: "Child", task: "Report which account served you." }],
	});
	const rows = (result.details as { results?: SingleResult[] } | undefined)?.results;
	const row = rows?.[0];
	if (!row) throw new Error(`task tool returned no result row: ${JSON.stringify(result.content)}`);
	return row;
}

/**
 * The reported state: every account but the session's (B) and one sibling (D) already
 * sits behind a long usage-limit block, and B runs out of quota on the session's next
 * request. Only D can serve; B must be tried once and never again.
 */
async function exhaustSessionAccount(): Promise<void> {
	for (const account of ["a", "c"] as const) {
		await authStorage.limits.markReached("anthropic", "other-session", {
			credentialId: credentialId(account),
			retryAfterMs: RETRY_AFTER_SECONDS * 1000,
			providerTimed: true,
		});
		server.exhausted.add(account);
		server.used[account] = 1;
	}
	server.exhausted.add("b");
}

function pinParentAutomatically(): void {
	expect(
		authStorage.sessions.pin("anthropic", PARENT_PROVIDER_SESSION, credentialId("b"), {
			restoredAtMs: Date.now(),
		}),
	).toBe(true);
}

const HOUR_MS = 60 * 60_000;
const REPORTED_MODEL_ID = "claude-opus-5-5";

/**
 * The reported pool, field for field: A and C sit behind persisted weekly walls from
 * earlier sessions; B, the session's warm automatic account, crosses its weekly cap on
 * the next request (5h nearly idle); D has no block, 66% of its weekly window used, a
 * Fable row, and no 5h row because no 5-hour session is open.
 */
async function reproduceReportedPool(): Promise<Model> {
	const reported = modelRegistry.find("anthropic", REPORTED_MODEL_ID);
	if (!reported) throw new Error(`anthropic/${REPORTED_MODEL_ID} missing from the registry`);
	for (const [account, wallMs] of [
		["a", 96 * HOUR_MS],
		["c", 31 * HOUR_MS],
	] as const) {
		await authStorage.limits.markReached("anthropic", "other-session", {
			credentialId: credentialId(account),
			retryAfterMs: wallMs,
			providerTimed: true,
			modelId: REPORTED_MODEL_ID,
		});
		server.exhausted.add(account);
		server.reports.set(account, [
			{ window: "7d", used: 1, resetsInMs: wallMs },
			{ window: "7d:fable", used: 0.2, resetsInMs: wallMs },
		]);
	}
	server.exhausted.add("b");
	server.reports.set("b", [
		{ window: "5h", used: 0.02, resetsInMs: 3 * HOUR_MS },
		{ window: "7d", used: 0.99, resetsInMs: RETRY_AFTER_SECONDS * 1000 },
		{ window: "7d:fable", used: 0.15, resetsInMs: RETRY_AFTER_SECONDS * 1000 },
	]);
	server.reports.set("d", [
		{ window: "7d", used: 0.66, resetsInMs: 82 * HOUR_MS },
		{ window: "7d:fable", used: 0.04, resetsInMs: 82 * HOUR_MS },
	]);
	pinParentAutomatically();
	return reported;
}

const PLACEMENTS = [
	{ name: "on the main thread", worker: false },
	{ name: "in a worker thread", worker: true },
] as const;

/**
 * Every request the server saw, in order: the child's first request reaches B and gets
 * its usage limit, and the run finishes on D. Nothing else reaches B, and nothing
 * reaches B or D before that 429.
 */
function expectChildFailoverToD(): void {
	expect(server.attempts).toEqual([
		{ origin: "child", account: "b", status: 429 },
		{ origin: "child", account: "d", status: 200 },
	]);
}

for (const placement of PLACEMENTS) {
	describe(`task subagent OAuth account routing ${placement.name}`, () => {
		beforeEach(() => {
			if (!placement.worker) return;
			pool = new SubagentWorkerPool({
				maxWorkers: () => 1,
				idleMs: 600_000,
				hostsOnMain: false,
				worker: { initTimeoutMs: 60_000 },
			});
			setSubagentWorkerPoolForTests(pool);
		});

		function expectPlacement(): void {
			if (placement.worker) expect(pool?.workers().length).toBe(1);
		}

		it(
			"ranks an unpinned child onto the account with the most headroom",
			async () => {
				const parent = await createParent(["task"]);

				const row = await runChild(parent);

				expect(row.exitCode).toBe(0);
				expect(server.childRequests.length).toBeGreaterThan(0);
				expect(server.childRequests.map(request => request.account)).toEqual(server.childRequests.map(() => "a"));
				expectPlacement();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"sends the child's requests on the parent's explicit account pin over usage ranking",
			async () => {
				const parent = await createParent(["task"]);
				expect(parent.pinCurrentProviderOAuthAccount(credentialId("b"))).toBe(true);

				const row = await runChild(parent);

				expect(row.exitCode).toBe(0);
				expect(server.childRequests.map(request => request.account)).toEqual(server.childRequests.map(() => "b"));
				expect(server.childRequests.length).toBeGreaterThan(0);
				expectPlacement();
			},
			TEST_TIMEOUT_MS,
		);

		it(
			"sends the child's requests on the parent's warm automatic account affinity",
			async () => {
				const parent = await createParent(["task"]);
				pinParentAutomatically();

				const row = await runChild(parent);

				expect(row.exitCode).toBe(0);
				expect(server.childRequests.length).toBeGreaterThan(0);
				expect(server.childRequests.map(request => request.account)).toEqual(server.childRequests.map(() => "b"));
				expectPlacement();
			},
			TEST_TIMEOUT_MS,
		);

		for (const pin of ["explicitly", "automatically"] as const) {
			it(
				`blocks the child's exhausted ${pin} pinned account and finishes the run on the sibling with quota`,
				async () => {
					const parent = await createParent(["task"]);
					if (pin === "explicitly") expect(parent.pinCurrentProviderOAuthAccount(credentialId("b"))).toBe(true);
					else pinParentAutomatically();
					await exhaustSessionAccount();

					const row = await runChild(parent);

					expect(row.error).toBeUndefined();
					expect(row.exitCode).toBe(0);
					expectChildFailoverToD();
					expectPlacement();
				},
				TEST_TIMEOUT_MS,
			);
		}

		it(
			"moves the child off its weekly-exhausted account onto the unblocked sibling with no 5h row",
			async () => {
				const reported = await reproduceReportedPool();
				const parent = await createParent(["task"], reported);

				const row = await runChild(parent);

				expect(row.error).toBeUndefined();
				expect(row.exitCode).toBe(0);
				expectChildFailoverToD();
				expectPlacement();
			},
			TEST_TIMEOUT_MS,
		);
	});
}

// The same account choices for the top-level session that spawns the children: the
// contract the children must match.
describe("top-level session OAuth account routing", () => {
	it(
		"sends the session's requests on its explicit account pin",
		async () => {
			const parent = await createParent(["task"]);
			expect(parent.pinCurrentProviderOAuthAccount(credentialId("b"))).toBe(true);

			await parent.prompt("Say hello.");
			await parent.waitForIdle();

			expect(server.parentRequests).toEqual([{ account: "b", status: 200 }]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"blocks the session's exhausted pinned account and answers on the sibling with quota",
		async () => {
			const parent = await createParent(["task"]);
			expect(parent.pinCurrentProviderOAuthAccount(credentialId("b"))).toBe(true);
			await exhaustSessionAccount();

			await parent.prompt("Say hello.");
			await parent.waitForIdle();

			expect(server.parentRequests).toEqual([
				{ account: "b", status: 429 },
				{ account: "d", status: 200 },
			]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"moves the session off its weekly-exhausted account onto the unblocked sibling with no 5h row",
		async () => {
			const reported = await reproduceReportedPool();
			const parent = await createParent(["task"], reported);

			await parent.prompt("Say hello.");
			await parent.waitForIdle();

			expect(server.parentRequests).toEqual([
				{ account: "b", status: 429 },
				{ account: "d", status: 200 },
			]);
		},
		TEST_TIMEOUT_MS,
	);
});
