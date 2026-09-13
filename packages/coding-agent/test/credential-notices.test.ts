import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type AssistantMessage, AuthStorage, type DisabledCredentialSummary } from "@oh-my-pi/pi-ai";
import * as oauthUtils from "@oh-my-pi/pi-ai/oauth";
import {
	collectDisabledCredentialNotices,
	formatCredentialDisabledNotice,
} from "@oh-my-pi/pi-coding-agent/config/credential-notices";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { withEnv } from "../../ai/test/helpers";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const oauthCredential = (expires: number) => ({
	type: "oauth" as const,
	access: "access-token",
	refresh: "refresh-token",
	expires,
	email: "signed-out@example.com",
	accountId: "acct-1",
});

describe("credential sign-out notices", () => {
	it("replays a racing teardown without a subscription mark, but deduplicates one observed live", async () => {
		authStorage = await AuthStorage.create(":memory:");
		const session = new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
		try {
			for (const subscribed of [false, true]) {
				const lookup = Promise.withResolvers<DisabledCredentialSummary[]>();
				vi.spyOn(authStorage, "listActionableDisabledCredentials").mockReturnValueOnce(lookup.promise);
				const live: AgentSessionEvent[] = [];
				const mark = session.disabledCredentialNoticeMark;
				const unsubscribe = subscribed
					? session.subscribe(event => {
							live.push(event);
						})
					: () => {};
				const replay = session.getDisabledCredentialNotices(subscribed ? { announcedAfter: mark } : undefined);
				session.announceCredentialDisabled({
					provider: "anthropic",
					credentialId: 99,
					credentialType: "oauth",
					email: "race@example.com",
					disabledCause: "invalid_grant",
				});
				lookup.resolve([
					{ provider: "anthropic", id: 99, type: "oauth", email: "race@example.com", cause: "invalid_grant" },
				]);
				const notices = await replay;
				if (subscribed) {
					expect(notices).toEqual([]);
					expect(live.filter(event => event.type === "notice")).toHaveLength(1);
				} else {
					expect(notices).toHaveLength(1);
					expect(notices[0]).toContain("race@example.com");
				}
				unsubscribe();
			}
		} finally {
			await session.dispose();
		}
	});
	let tempDir = "";
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-notices-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage?.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	it("replays an automatic sign-out at startup until the account signs in again", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		await authStorage.set("anthropic", [oauthCredential(Date.now() - 60_000)]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"grant revoked"}');
		});
		await withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
			expect(await authStorage!.getApiKey("anthropic", "session")).toBeUndefined();
		});

		const notices = await collectDisabledCredentialNotices(authStorage, Date.now());
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("anthropic signed-out@example.com was signed out");
		expect(notices[0]).toContain("grant revoked");
		expect(notices[0]).toContain("/login anthropic");
		// A teardown a live notice already announced to the caller is not
		// repeated, and membership is read once the lookup has settled, so an
		// announcement landing mid-lookup still counts.
		const [tombstone] = await authStorage.listDisabledCredentials("anthropic");
		if (!tombstone) throw new Error("tombstone missing");
		const announced = new Set<number>();
		const listing = authStorage.listActionableDisabledCredentials.bind(authStorage);
		vi.spyOn(authStorage, "listActionableDisabledCredentials").mockImplementationOnce(async (...args) => {
			const result = await listing(...args);
			expect(result.map(summary => summary.id)).toEqual([tombstone.id]);
			announced.add(tombstone.id);
			return result;
		});
		expect(await collectDisabledCredentialNotices(authStorage, Date.now(), id => announced.has(id))).toEqual([]);

		await authStorage.set("anthropic", [oauthCredential(Date.now() + 3_600_000)]);
		expect(await collectDisabledCredentialNotices(authStorage, Date.now())).toEqual([]);
	});

	it("never lets a failed tombstone listing break startup", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		vi.spyOn(authStorage, "listActionableDisabledCredentials").mockRejectedValue(new Error("broker offline"));

		expect(await collectDisabledCredentialNotices(authStorage, Date.now())).toEqual([]);
	});

	it("gives up on a stalled tombstone listing within the startup budget", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		// A broker that never answers: the listing only settles when the caller's
		// signal fires, which is what bounds startup.
		vi.spyOn(authStorage, "listActionableDisabledCredentials").mockImplementation((_provider, signal) => {
			const { promise, reject } = Promise.withResolvers<never>();
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
			return promise;
		});

		const startedAt = Date.now();
		expect(await collectDisabledCredentialNotices(authStorage, Date.now())).toEqual([]);
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	});

	it("shares one replay deadline between tombstones and retained-event recovery", async () => {
		authStorage = await AuthStorage.create(":memory:");
		const session = new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: "Main",
		});
		try {
			session.announceCredentialDisabled({
				provider: "anthropic",
				credentialId: 99,
				credentialType: "oauth",
				email: "retained@example.com",
				disabledCause: "invalid_grant",
			});
			vi.spyOn(authStorage, "listActionableDisabledCredentials").mockImplementation(async () => {
				await Bun.sleep(1_000);
				return [];
			});
			vi.spyOn(authStorage, "revalidateCredentials").mockImplementation(signal => {
				const { promise, reject } = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				return promise;
			});
			const startedAt = performance.now();
			const notices = await session.getDisabledCredentialNotices();
			expect(performance.now() - startedAt).toBeLessThan(2_700);
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("retained@example.com");
		} finally {
			await session.dispose();
		}
	});

	it("names at most a screenful of signed-out accounts at startup and counts the rest", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		const nowMs = Date.now();
		// SQLite lists tombstones by ascending id; the newest sign-out is the last row.
		vi.spyOn(authStorage, "listActionableDisabledCredentials").mockResolvedValue(
			Array.from({ length: 11 }, (_, index) => ({
				id: index + 1,
				provider: "openai-codex",
				type: "oauth" as const,
				email: `user${index + 1}@example.com`,
				cause: "oauth refresh failed: invalid_grant",
				disabledAtMs: nowMs - (11 - index) * 60_000,
			})),
		);

		const notices = await collectDisabledCredentialNotices(authStorage, nowMs);
		expect(notices).toHaveLength(9);
		expect(notices[0]).toContain("user11@example.com");
		expect(notices[7]).toContain("user4@example.com");
		expect(notices[8]).toContain("3 more");
		expect(notices[8]).toContain("omp usage");
	});

	it("bounds a runaway provider description without cutting the remedy", () => {
		const notice = formatCredentialDisabledNotice({
			credentialId: 1,
			credentialType: "oauth",
			email: `${"x".repeat(200)}@example.com`,
			provider: `extension-provider-${"y".repeat(120)}`,
			disabledCause: `HTTP 400 {"error":"invalid_grant","error_description":"${"grant revoked ".repeat(40)}"}`,
		});
		// provider (TITLE) + label (TITLE) + cause (CONTENT) + fixed wording.
		expect(notice.length).toBeLessThan(60 + 60 + 80 + 80);
		expect(notice).toMatch(/extension-provider-y+…/);
		expect(notice).toMatch(/x+…/);
		// `/login` matches its argument exactly: a cut id is not offered as one.
		expect(notice).toContain("/login");
		expect(notice).not.toContain("/login extension-provider-");
		// Nor is an id the display sanitizer would alter.
		const sanitized = formatCredentialDisabledNotice({
			credentialId: 2,
			credentialType: "oauth",
			email: "x@example.com",
			provider: "ext\tprovider",
			disabledCause: "oauth refresh failed: invalid_grant",
		});
		expect(sanitized).toContain("x@example.com");
		expect(sanitized).toContain("/login");
		expect(sanitized).not.toContain("/login ext");
		expect(sanitized).not.toContain("\t");
	});

	it("strips terminal control sequences and tabs from provider-controlled notice text", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		await authStorage.set("anthropic", [
			{ ...oauthCredential(Date.now() - 60_000), email: "who\x1b[2Jami@example.com" },
		]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error(
				'HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"grant\trevoked\x1b[31m!"}',
			);
		});
		await withEnv({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, async () => {
			expect(await authStorage!.getApiKey("anthropic", "session")).toBeUndefined();
		});

		const [notice] = await collectDisabledCredentialNotices(authStorage, Date.now());
		expect(notice).toContain("whoami@example.com");
		// Unescaped controls make this JSON malformed; its body is withheld.
		expect(notice).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
		expect(notice).toContain("/login anthropic");
		const live = formatCredentialDisabledNotice({
			provider: "anthropic",
			credentialId: 1,
			credentialType: "oauth",
			email: "who\x1b[2Jami@example.com",
			disabledCause: "oauth refresh failed: grant\trevoked\x1b[31m!",
		});
		expect(live).toContain("whoami@example.com");
		expect(live).toMatch(/grant +revoked/);
		expect(live).toContain("/login anthropic");
		expect(live).not.toMatch(/[\x00-\x1F\x7F]/);
	});

	it("writes a warning notice raised during a text-mode print run to stderr", async () => {
		const stderrOutput: string[] = [];
		vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
			stderrOutput.push(String(chunk));
			return true;
		});
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const last = args[args.length - 1];
			if (typeof last === "function") last();
			return true;
		});
		const answer: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "done" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		let notify: ((event: AgentSessionEvent) => void) | undefined;
		const session = {
			state: { messages: [answer] },
			getLastAssistantMessage: () => answer,
			settings: { get: () => false },
			sessionManager: {
				getHeader: () => undefined,
				buildSessionContext: () => ({ messages: [] }),
				getEntries: () => [],
			},
			extensionRunner: undefined,
			disabledCredentialNoticeMark: 3,
			// Replay must not race past listener registration.
			getDisabledCredentialNotices: async () => {
				if (!notify) throw new Error("replayed before subscribing");
				return [
					"anthropic b@example.com was signed out 5s ago: invalid_grant. Sign in again with /login anthropic.",
				];
			},
			subscribe: (listener: (event: AgentSessionEvent) => void) => {
				notify = listener;
				return () => {};
			},
			prompt: async () => {
				// The account behind the request is torn down mid-turn while a sibling serves it.
				notify?.({
					type: "notice",
					level: "warning",
					message: "Signed out of anthropic a@example.com",
					source: "auth",
				});
				notify?.({ type: "notice", level: "info", message: "Prewalk: armed", source: "prewalk" });
			},
			prepareForHeadlessAdvisorDrain: () => {},
			setTextOutputCommitted: () => {},
			waitForAdvisorCatchup: async () => true,
			dispose: async () => {},
		} as unknown as AgentSession;

		expect(await runPrintMode(session, { mode: "text", initialMessage: "hello" })).toBe(0);
		const output = stderrOutput.join("");
		expect(output).toContain("invalid_grant");
		expect(output).toContain("/login anthropic");
		expect(output).toContain("b@example.com");
		expect(output.indexOf("b@example.com")).toBeLessThan(output.indexOf("a@example.com"));
		expect(output).toContain("a@example.com");
		expect(output).not.toContain("Prewalk: armed");
	});

	it("announces the sign-out before `omp -p` gives up on an empty pool", async () => {
		const home = path.join(tempDir, "home");
		const agentDir = path.join(home, ".omp", "agent");
		fs.mkdirSync(agentDir, { recursive: true });
		const seeded = await AuthStorage.create(path.join(agentDir, "agent.db"));
		try {
			await seeded.set("openai-codex", [oauthCredential(Date.now() - 60_000)]);
			const id = seeded.exportSnapshot().credentials[0]!.id;
			expect(seeded.disableCredentialById(id, "oauth refresh failed: OAuthError: 400 invalid_grant")).toBe(true);
		} finally {
			seeded.close();
		}

		// Only the tombstone is left: the run has no model and exits before any prompt.
		const proc = Bun.spawn([process.execPath, cliEntry, "-p", "hello", "--no-extensions"], {
			cwd: repoRoot,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH,
				HOME: home,
				PI_CODING_AGENT_DIR: agentDir,
				NO_COLOR: "1",
				PI_NO_TITLE: "1",
			},
		});
		const [stderr, exitCode] = await Promise.all([
			new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
			proc.exited,
		]);

		expect(exitCode).toBe(1);
		const noticeAt = stderr.indexOf("signed-out@example.com");
		const exitAt = stderr.indexOf("No models available");
		expect(noticeAt, stderr).toBeGreaterThanOrEqual(0);
		expect(exitAt, stderr).toBeGreaterThan(noticeAt);
		expect(stderr).toContain("/login openai-codex");
	}, 60_000);

	it("names the account, cause, and recovery operation for live teardown", () => {
		const oauth = formatCredentialDisabledNotice({
			provider: "openai-codex",
			credentialId: 16,
			credentialType: "oauth",
			email: "signed-out@example.com",
			orgName: "Example Org",
			disabledCause: "oauth refresh failed: OAuthError: invalid_grant; refresh token expired",
		});
		expect(oauth).toContain("signed-out@example.com");
		expect(oauth).toContain("Example Org");
		expect(oauth).toContain("invalid_grant");
		expect(oauth).toContain("/login openai-codex");
		const apiKey = formatCredentialDisabledNotice({
			provider: "kagi",
			credentialId: 2,
			credentialType: "api_key",
			disabledCause: "disabled via auth-broker",
		});
		expect(apiKey).toContain("API key");
		expect(apiKey).toContain("disabled via auth-broker");
		expect(apiKey).toContain("/login kagi");
		const mcp = formatCredentialDisabledNotice({
			provider: "mcp_oauth:profile:default:https://mcp.example.com/sse?ref=abc&apiKey=sk-secret",
			credentialId: 3,
			credentialType: "oauth",
			disabledCause: "oauth refresh failed: invalid_grant",
		});
		expect(mcp).toContain("mcp.example.com");
		expect(mcp).toContain("ref=abc");
		expect(mcp).not.toContain("sk-secret");
		expect(mcp).toContain("invalid_grant");
		expect(mcp).toContain("/mcp reauth");
		expect(mcp).not.toContain("/login");
	});
});
