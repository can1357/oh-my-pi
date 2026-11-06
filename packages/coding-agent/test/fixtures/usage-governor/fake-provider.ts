/**
 * Loopback fake for the usage-governor CLI proof. It serves two things to the child `omp`
 * process: OpenAI-compatible chat completions (SSE) and a per-account usage endpoint. Every
 * request is recorded so scenarios assert against what actually reached the wire, never
 * against what the child reported.
 *
 * Model of one account: a 60 s window whose used fraction rises by `perRequest` per chat send
 * and rolls to zero at each reset, a static weekly window, and an optional banked-reset
 * inventory served through the usage report. Anything outside the chat and usage routes is
 * recorded as `unexpected` and answered 404, so a redeem or any other call shows up in the log.
 *
 * Main-model script for a prompt containing `DELEGATE`: call `task`, then `wait` for the spawned
 * subagent, then reply with text. Subagent turns (on `govplan-g`) reply with text.
 */

export const WINDOW_MS = 60_000;
export const WEEK_MS = 7 * 24 * 60 * 60_000;

export type FakeProviderId = "govplan" | "govplan-g";

/** Static description of one account the fake serves. */
export interface FakeAccountSpec {
	provider: FakeProviderId;
	/** Test-local label, used in assertions. */
	label: string;
	/** OAuth access token; the fake maps it to the account and the child sends it as the bearer. */
	bearer: string;
	/** Seed a stored login API key instead of an OAuth credential. */
	authType?: "api_key";
	accountId: string;
	email: string;
	/** Used fraction of the 60 s window at start. */
	usedFraction: number;
	/** Milliseconds from start to the 60 s window reset. */
	resetInMs: number;
	/** Used fraction added to the 60 s window per chat send. */
	perRequest: number;
	/** Weekly used fraction; static, never incremented by sends. */
	weeklyUsedFraction?: number;
	/** Banked resets served with the usage report; `usable` marks them redeemable now. */
	bankedResets?: { count: number; usable: boolean };
	/** Paid overage balance, separate from the included renewable window and banked resets. */
	creditBalance?: number;
	/** Usage endpoint answers 500 while true. */
	failUsage?: boolean;
}

interface AccountState extends FakeAccountSpec {
	resetsAt: number;
	weekResetsAt: number;
}

export type FakeRecordKind = "chat" | "usage" | "unexpected";

export interface FakeRecord {
	kind: FakeRecordKind;
	/** Request path, for example `/govplan/v1/chat/completions`. */
	path: string;
	provider?: FakeProviderId;
	label?: string;
	bearer?: string;
	model?: string;
	/** Names of the tools the request offered. */
	toolNames?: string[];
	/** Tool results carried in the request, truncated. */
	toolResults?: string[];
	/** 60 s window used fraction after this request was accounted (chat) or served (usage). */
	usedFraction?: number;
	/** 60 s window reset served with the request. */
	resetsAt?: number;
	/** Epoch ms when the fake saw the request. */
	atMs: number;
}

export interface FakeProvider {
	/** Base URL with no trailing slash, for example `http://127.0.0.1:41234`. */
	readonly url: string;
	readonly records: readonly FakeRecord[];
	/** Live account state, read by scenarios between phases. */
	account(label: string): Readonly<AccountState>;
	/** Mutate an account's served state between phases (for example to make usage fail). */
	patch(label: string, change: Partial<Pick<FakeAccountSpec, "failUsage" | "usedFraction">>): void;
	/** Chat records only, in arrival order. */
	chats(): FakeRecord[];
	close(): void;
}

/** Roll a window that has reset: used fraction back to zero, next reset one window later. */
function roll(account: AccountState, nowMs: number): void {
	while (nowMs >= account.resetsAt) {
		account.usedFraction = 0;
		account.resetsAt += WINDOW_MS;
	}
	while (nowMs >= account.weekResetsAt) {
		account.weekResetsAt += WEEK_MS;
	}
}

function usageReport(account: AccountState, nowMs: number): Record<string, unknown> {
	roll(account, nowMs);
	const weekly = account.weeklyUsedFraction ?? 0;
	const report: Record<string, unknown> = {
		provider: account.provider,
		fetchedAt: nowMs,
		limits: [
			{
				id: "requests-60s",
				label: "Requests 60s",
				scope: { provider: account.provider, accountId: account.accountId },
				window: { id: "60s", label: "60 Second", durationMs: WINDOW_MS, resetsAt: account.resetsAt },
				amount: {
					usedFraction: account.usedFraction,
					used: account.usedFraction * 100,
					limit: 100,
					unit: "percent",
				},
			},
			{
				id: "requests-7d",
				label: "Requests 7d",
				scope: { provider: account.provider, accountId: account.accountId },
				window: { id: "7d", label: "7 Day", durationMs: WEEK_MS, resetsAt: account.weekResetsAt },
				amount: { usedFraction: weekly, used: weekly * 100, limit: 100, unit: "percent" },
			},
		],
	};
	if (account.creditBalance !== undefined) {
		(report.limits as Array<Record<string, unknown>>).push({
			id: "paid-credits",
			label: "Paid credits",
			scope: { provider: account.provider, accountId: account.accountId },
			amount: { remaining: account.creditBalance, unit: "credits" },
		});
	}
	if (account.bankedResets) {
		const { count, usable } = account.bankedResets;
		report.resetCredits = {
			availableCount: count,
			redeemableCount: usable ? count : 0,
			eligible: usable,
			reason: usable ? undefined : "not eligible",
			credits: Array.from({ length: count }, (_, index) => ({
				id: `credit-${account.label}-${index}`,
				title: "Banked reset",
				usable,
				requiresLimit: true,
				clears: ["requests-60s"],
				expiresAt: new Date(nowMs + 24 * 60 * 60_000).toISOString(),
				status: "available",
			})),
		};
	}
	return report;
}

type ScriptedReply = { kind: "text"; text: string } | { kind: "tool"; name: string; args: unknown };

function sse(model: string, reply: ScriptedReply): string {
	const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model };
	const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
	const chunks =
		reply.kind === "text"
			? [
					{
						...base,
						choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }],
					},
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage },
				]
			: [
					{
						...base,
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: `call_${reply.name}_1`,
											type: "function",
											function: { name: reply.name, arguments: JSON.stringify(reply.args) },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage },
				];
	return `${chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
}

interface ChatMessage {
	role?: string;
	content?: unknown;
}

function messageText(message: ChatMessage): string {
	if (typeof message.content === "string") return message.content;
	if (Array.isArray(message.content)) {
		return message.content
			.map(part => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
			.join("\n");
	}
	return "";
}

/**
 * The reply for one chat request. The main model delegates on a `DELEGATE` prompt in three
 * steps (`task`, then `wait`, then text); a subagent (`govplan-g`) answers with text.
 */
function replyFor(provider: FakeProviderId, messages: ChatMessage[], toolResultCount: number): ScriptedReply {
	if (
		provider === "govplan" &&
		messages.some(message => message.role === "user" && messageText(message).includes("ROUTE_PIN"))
	) {
		return toolResultCount < 5
			? { kind: "tool", name: "govplan_pin_probe", args: {} }
			: { kind: "text", text: "done" };
	}
	const delegates =
		provider === "govplan" &&
		messages.some(message => message.role === "user" && messageText(message).includes("DELEGATE"));
	if (!delegates) return { kind: "text", text: "ok" };
	if (toolResultCount === 0) {
		return {
			kind: "tool",
			name: "task",
			args: {
				context: "usage governor proof",
				tasks: [{ name: "worker", task: "Reply with the word ok.", solutionSpace: "fixed reply" }],
			},
		};
	}
	if (toolResultCount === 1) return { kind: "tool", name: "wait", args: {} };
	return { kind: "text", text: "done" };
}

const RESULT_PREVIEW_CHARS = 240;

/** Start the fake on a loopback port. Accounts are keyed by bearer for chat and usage. */
export function startFakeProvider(specs: readonly FakeAccountSpec[], now: () => number = Date.now): FakeProvider {
	const accounts = new Map<string, AccountState>();
	const byLabel = new Map<string, AccountState>();
	const records: FakeRecord[] = [];
	const bootMs = now();
	for (const spec of specs) {
		const state: AccountState = {
			...spec,
			resetsAt: bootMs + spec.resetInMs,
			weekResetsAt: bootMs + WEEK_MS,
		};
		accounts.set(spec.bearer, state);
		byLabel.set(spec.label, state);
	}

	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const atMs = now();
			const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
			const account = accounts.get(bearer);
			const provider = (url.pathname.split("/")[1] ?? "") as FakeProviderId;

			if (request.method === "POST" && url.pathname.endsWith("/chat/completions") && account) {
				const body = (await request.json()) as {
					model?: string;
					messages?: ChatMessage[];
					tools?: Array<{ function?: { name?: string }; name?: string }>;
				};
				const messages = body.messages ?? [];
				const model = body.model ?? "m";
				const toolResults = messages
					.filter(message => message.role === "tool")
					.map(message => messageText(message).slice(0, RESULT_PREVIEW_CHARS));
				roll(account, atMs);
				account.usedFraction += account.perRequest;
				records.push({
					kind: "chat",
					path: url.pathname,
					provider: account.provider,
					label: account.label,
					bearer,
					model,
					toolNames: (body.tools ?? []).map(tool => tool.function?.name ?? tool.name ?? ""),
					toolResults,
					usedFraction: account.usedFraction,
					resetsAt: account.resetsAt,
					atMs,
				});
				const reply = replyFor(account.provider, messages, toolResults.length);
				return new Response(sse(model, reply), { headers: { "content-type": "text/event-stream" } });
			}

			if (request.method === "GET" && url.pathname.endsWith("/usage") && account) {
				const report = usageReport(account, atMs);
				records.push({
					kind: "usage",
					path: url.pathname,
					provider: account.provider,
					label: account.label,
					bearer,
					usedFraction: account.usedFraction,
					resetsAt: account.resetsAt,
					atMs,
				});
				if (account.failUsage) return Response.json({ error: "upstream usage failure" }, { status: 500 });
				return Response.json(report);
			}

			records.push({ kind: "unexpected", path: `${request.method} ${url.pathname}`, provider, atMs });
			return Response.json({ error: "not served by the usage governor fake" }, { status: 404 });
		},
	});

	return {
		url: `http://127.0.0.1:${server.port}`,
		get records() {
			return records;
		},
		account(label) {
			const state = byLabel.get(label);
			if (!state) throw new Error(`unknown fake account ${label}`);
			return state;
		},
		patch(label, change) {
			const state = byLabel.get(label);
			if (!state) throw new Error(`unknown fake account ${label}`);
			if (change.failUsage !== undefined) state.failUsage = change.failUsage;
			if (change.usedFraction !== undefined) state.usedFraction = change.usedFraction;
		},
		chats() {
			return records.filter(record => record.kind === "chat");
		},
		close() {
			server.stop(true);
		},
	};
}
