// Gallery fixtures for the agentic orchestration tools (task, hub, goal).
import type { Usage } from "@oh-my-pi/pi-ai";
import type { TaskToolDetails } from "../../task/types";
import type { HubDetails } from "../../tools/hub";
import type { GalleryFixture } from "./types";

/** Message/activity timestamps are offsets from load time so gallery ages stay plausible. */
const FIXTURE_NOW = Date.now();

/** Plausible cumulative usage for a fixture subagent run. */
const fixtureUsage = (tokens: { input: number; output: number }, costTotal: number): Usage => ({
	input: tokens.input,
	output: tokens.output,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: tokens.input + tokens.output,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
});

export const agenticFixtures: Record<string, GalleryFixture> = {
	task: {
		label: "Task",
		customRendered: true,
		// Streaming: agent chosen, assignment still landing.
		streamingArgs: {
			agent: "task",
			id: "AuthLoader",
			description: "Load auth middleware",
			assignment: "Read packages/server/src/auth/*.ts and summarize the session-cookie",
		},
		args: {
			agent: "task",
			id: "AuthLoader",
			description: "Load auth middleware",
			assignment:
				"Read packages/server/src/auth/session.ts and middleware.ts, then document the session-cookie validation flow and any TODOs.",
		},
		result: {
			content: [
				{
					type: "text",
					text: "Agent AuthLoader completed.",
				},
			],
			details: {
				projectAgentsDir: null,
				totalDurationMs: 48_200,
				usage: fixtureUsage({ input: 52_600, output: 8_800 }, 0.12),
				progress: [
					{
						index: 0,
						id: "AuthLoader",
						agent: "task",
						agentSource: "bundled",
						status: "completed",
						task: "Read packages/server/src/auth/session.ts and middleware.ts",
						description: "Load auth middleware",
						lastIntent: "Documenting session-cookie flow",
						recentTools: [
							{ tool: "read", args: "packages/server/src/auth/session.ts", endMs: 1_749_200_040_000 },
							{ tool: "read", args: "packages/server/src/auth/middleware.ts", endMs: 1_749_200_052_000 },
						],
						recentOutput: ["Session validation runs in middleware.ts:42 via verifySessionCookie()."],
						toolCount: 9,
						requests: 6,
						tokens: 61_400,
						contextTokens: 23_100,
						contextWindow: 200_000,
						cost: 0.12,
						durationMs: 41_900,
						resolvedModel: "anthropic/claude-sonnet",
					},
				],
				results: [
					{
						index: 0,
						id: "AuthLoader",
						agent: "task",
						agentSource: "bundled",
						description: "Load auth middleware",
						task: "Read packages/server/src/auth/session.ts and middleware.ts",
						assignment:
							"Read packages/server/src/auth/session.ts and middleware.ts, then document the session-cookie validation flow and any TODOs.",
						exitCode: 0,
						output: [
							"Session validation runs in middleware.ts:42 via verifySessionCookie().",
							"Cookies are HMAC-signed (SHA-256) and checked against the session store.",
							"TODO at session.ts:88 — sliding-expiration refresh is stubbed.",
						].join("\n"),
						stderr: "",
						truncated: false,
						durationMs: 41_900,
						tokens: 61_400,
						requests: 6,
						contextTokens: 23_100,
						contextWindow: 200_000,
						resolvedModel: "anthropic/claude-sonnet",
						usage: fixtureUsage({ input: 52_600, output: 8_800 }, 0.12),
						outputMeta: { lineCount: 3, charCount: 214 },
					},
				],
			} satisfies TaskToolDetails,
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: "Agent RateLimiter failed.",
				},
			],
			details: {
				projectAgentsDir: null,
				totalDurationMs: 9_800,
				usage: fixtureUsage({ input: 10_900, output: 1_400 }, 0.1),
				results: [
					{
						index: 0,
						id: "RateLimiter",
						agent: "task",
						agentSource: "bundled",
						description: "Audit rate limiter",
						task: "Inspect packages/server/src/auth/rate-limit.ts",
						assignment:
							"Inspect packages/server/src/auth/rate-limit.ts. Confirm the 429 path sets Retry-After and report gaps.",
						exitCode: 1,
						output: "",
						stderr: "ENOENT: packages/server/src/auth/rate-limit.ts",
						truncated: false,
						durationMs: 9_800,
						tokens: 12_300,
						requests: 3,
						contextTokens: 6_400,
						contextWindow: 200_000,
						resolvedModel: "anthropic/claude-sonnet",
						usage: fixtureUsage({ input: 10_900, output: 1_400 }, 0.1),
						error: "Subagent exited 1: target file packages/server/src/auth/rate-limit.ts does not exist.",
						outputMeta: { lineCount: 0, charCount: 0 },
					},
				],
			} satisfies TaskToolDetails,
		},
	},

	hub_send: {
		label: "Hub send",
		renderer: "hub",
		// Streaming: recipient known; the message body still arriving.
		streamingArgs: { op: "send", to: "AuthLoader", message: "Are you still touching" },
		args: {
			op: "send",
			to: "AuthLoader",
			message: "Are you still touching src/server/auth.ts? I need to add a 401 path.",
			await: true,
		},
		result: {
			content: [
				{
					type: "text",
					text: [
						"Delivered to 1 peer(s):",
						"- AuthLoader: revived",
						"",
						"Reply from AuthLoader:",
						"Done with auth.ts — go ahead, just rebase past my session-store rename.",
					].join("\n"),
				},
			],
			details: {
				op: "send",
				from: "Main",
				to: "AuthLoader",
				receipts: [{ to: "AuthLoader", outcome: "revived" }],
				waited: {
					id: "7181122334455667789",
					from: "AuthLoader",
					to: "Main",
					body: "Done with auth.ts — go ahead, just rebase past my session-store rename.",
					ts: FIXTURE_NOW - 5_000,
					replyTo: "7181122334455667788",
				},
			} satisfies HubDetails,
		},
		errorResult: {
			isError: true,
			content: [
				{
					type: "text",
					text: 'No recipients received the message.\n- RateLimiter: failed — unknown agent "RateLimiter"',
				},
			],
			details: {
				op: "send",
				from: "Main",
				to: "RateLimiter",
				receipts: [{ to: "RateLimiter", outcome: "failed", error: 'unknown agent "RateLimiter"' }],
			} satisfies HubDetails,
		},
	},

	hub_wait: {
		label: "Hub wait",
		customRendered: true,
		renderer: "hub",
		streamingArgs: { op: "wait", from: "AuthLoader" },
		args: { op: "wait", from: "AuthLoader", timeoutMs: 60_000 },
		result: {
			content: [
				{
					type: "text",
					text: "[7181122334455667790] AuthLoader: session-store rename is merged; auth.ts is yours.",
				},
			],
			details: {
				op: "wait",
				from: "Main",
				waited: {
					id: "7181122334455667790",
					from: "AuthLoader",
					to: "Main",
					body: "session-store rename is merged; auth.ts is yours.",
					ts: FIXTURE_NOW - 30_000,
				},
			} satisfies HubDetails,
		},
	},

	hub_inbox: {
		label: "Hub inbox",
		customRendered: true,
		renderer: "hub",
		streamingArgs: { op: "inbox" },
		args: { op: "inbox", peek: true },
		result: {
			content: [
				{
					type: "text",
					text: [
						"2 unread message(s):",
						"- [7181122334455667791] AuthLoader: hub table reads unreadCount — ping me when the bus lands.",
						"- [7181122334455667792] RateLimiter (reply to 7181122334455667791): bus is in; receipts carry outcome.",
					].join("\n"),
				},
			],
			details: {
				op: "inbox",
				from: "Main",
				inbox: [
					{
						id: "7181122334455667791",
						from: "AuthLoader",
						to: "Main",
						body: "hub table reads unreadCount — ping me when the bus lands.",
						ts: FIXTURE_NOW - 4 * 60_000,
					},
					{
						id: "7181122334455667792",
						from: "RateLimiter",
						to: "Main",
						body: "bus is in; receipts carry outcome.",
						ts: FIXTURE_NOW - 60_000,
						replyTo: "7181122334455667791",
					},
				],
			} satisfies HubDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "IRC inbox failed: message store unavailable." }],
			details: { op: "inbox" } satisfies HubDetails,
		},
	},

	hub_list: {
		label: "Hub peers",
		customRendered: true,
		renderer: "hub",
		streamingArgs: { op: "list" },
		args: { op: "list" },
		result: {
			content: [
				{
					type: "text",
					text: [
						"2 peer(s):",
						"- AuthLoader [task · sub · idle] — parent Main, active 2m ago",
						"- RateLimiter [task · sub · parked] — unread 2, parent Main, active 12m ago",
						"",
						"Parked agents are revived automatically when you message them.",
					].join("\n"),
				},
			],
			details: {
				op: "list",
				from: "Main",
				peers: [
					{
						id: "AuthLoader",
						displayName: "task",
						kind: "sub",
						status: "idle",
						parentId: "Main",
						unread: 0,
						lastActivity: FIXTURE_NOW - 2 * 60_000,
					},
					{
						id: "RateLimiter",
						displayName: "task",
						kind: "sub",
						status: "parked",
						parentId: "Main",
						unread: 2,
						lastActivity: FIXTURE_NOW - 12 * 60_000,
					},
				],
			} satisfies HubDetails,
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "IRC list failed: agent hub is unavailable." }],
			details: { op: "list" } satisfies HubDetails,
		},
	},

	goal: {
		label: "Goal",
		// Streaming: op is "create"; objective text still being typed.
		streamingArgs: { op: "create", objective: "Ship the auth hardening" },
		args: {
			op: "create",
			objective: "Ship the auth hardening pass: per-account rate limits and sliding session expiry.",
			token_budget: 500_000,
		},
		result: {
			content: [
				{
					type: "text",
					text: "Goal set. Working toward: Ship the auth hardening pass.",
				},
			],
			details: {
				op: "create",
				remainingTokens: 451_800,
				completionBudgetReport: null,
				goal: {
					id: "goal_8f2a",
					objective: "Ship the auth hardening pass: per-account rate limits and sliding session expiry.",
					status: "active",
					tokenBudget: 500_000,
					tokensUsed: 48_200,
					timeUsedSeconds: 312,
					createdAt: 1_749_200_000_000,
					updatedAt: 1_749_200_312_000,
				},
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "Goal tool failed: objective is required when op=create." }],
			details: { op: "create" },
		},
	},

	think: {
		label: "Think",
		// Streaming: scratchpad thoughts still arriving.
		streamingArgs: {
			thoughts: "The retry loop re-reads the config after every failure, which explains the doubled latency.",
		},
		args: {
			thoughts:
				"The retry loop re-reads the config after every failure, which explains the doubled latency. Cache the parsed config outside the loop, then re-check the invalidation path.",
		},
		result: {
			content: [{ type: "text", text: "------" }],
			details: { recorded: true },
		},
	},

	hub_jobs: {
		label: "Hub jobs",
		renderer: "hub",
		// Streaming: waiting on a single job id; the second id is still arriving.
		streamingArgs: { op: "wait", ids: ["job_a1"] },
		args: { op: "wait", ids: ["job_a1", "job_b2", "job_c3"] },
		result: {
			content: [{ type: "text", text: "3 jobs settled." }],
			details: {
				op: "wait",
				jobs: [
					{
						id: "job_a1",
						type: "bash",
						status: "completed",
						label: "bun test packages/server/test/auth.test.ts",
						durationMs: 18_400,
						resultText: "42 pass, 0 fail (18.4s)",
					},
					{
						id: "job_b2",
						type: "task",
						status: "completed",
						label: "Migrate rate limiter to a sliding window",
						durationMs: 96_700,
						resultText: "Rewrote rate-limit.ts to a token-bucket; added per-account keys.",
					},
					{
						id: "job_c3",
						type: "bash",
						status: "failed",
						label: "bunx biome check packages/server/src/auth",
						durationMs: 4_100,
						errorText: "biome: 2 errors in tokens.ts — noUnusedVariables, useConst",
					},
				],
			},
		},
		errorResult: {
			isError: true,
			content: [{ type: "text", text: "1 job failed." }],
			details: {
				op: "wait",
				jobs: [
					{
						id: "job_d4",
						type: "task",
						status: "failed",
						label: "Refactor the session store to Redis",
						durationMs: 52_300,
						errorText: "Subagent exited 1: Redis connection string is missing.",
					},
				],
			},
		},
	},
};
