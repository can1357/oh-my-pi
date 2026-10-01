// Gallery fixtures for agentic orchestration (task, wait, goal).
import type { Usage } from "@oh-my-pi/pi-ai";
import type { TaskToolDetails } from "@oh-my-pi/pi-tui/tools/task";
import type { CoordinationDetails } from "@oh-my-pi/pi-tui/tools/wait";
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
		// Streaming: agent chosen, assignment still landing. The args follow the
		// tool schema `renderCall` reads (`agent`, `name`, `task`).
		streamingArgs: {
			agent: "task",
			name: "AuthLoader",
			task: "Read packages/server/src/auth/*.ts and summarize the session-cookie",
		},
		args: {
			agent: "task",
			name: "AuthLoader",
			task: "Read packages/server/src/auth/session.ts and middleware.ts, then document the session-cookie validation flow and any TODOs.",
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

	wait_message: {
		label: "Wait for message",
		customRendered: true,
		renderer: "wait",
		streamingArgs: {},
		args: {},
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
			} satisfies CoordinationDetails,
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

	wait: {
		label: "Wait for jobs",
		streamingArgs: {},
		args: {},
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
