import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type AssistantMessage, AuthStorage } from "@oh-my-pi/pi-ai";
import * as oauthUtils from "@oh-my-pi/pi-ai/oauth";
import {
	collectDisabledCredentialNotices,
	formatCredentialDisabledNotice,
} from "@oh-my-pi/pi-coding-agent/config/credential-notices";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

const repoRoot = path.resolve(import.meta.dir, "..", "..", "..");
const cliEntry = path.join(repoRoot, "packages", "coding-agent", "src", "cli.ts");

const SUPPRESS_ANTHROPIC_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"] as const;
const savedEnv: Partial<Record<(typeof SUPPRESS_ANTHROPIC_ENV)[number], string | undefined>> = {};

const oauthCredential = (expires: number) => ({
	type: "oauth" as const,
	access: "access-token",
	refresh: "refresh-token",
	expires,
	email: "signed-out@example.com",
	accountId: "acct-1",
});

describe("credential sign-out notices", () => {
	let tempDir = "";
	let authStorage: AuthStorage | undefined;

	beforeEach(() => {
		for (const key of SUPPRESS_ANTHROPIC_ENV) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "credential-notices-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		authStorage?.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
		for (const key of SUPPRESS_ANTHROPIC_ENV) {
			if (savedEnv[key] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[key];
		}
	});

	it("replays an automatic sign-out at startup until the account signs in again", async () => {
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		await authStorage.set("anthropic", [oauthCredential(Date.now() - 60_000)]);
		vi.spyOn(oauthUtils, "refreshOAuthToken").mockImplementation(async () => {
			throw new Error('HTTP 400 invalid_grant {"error":"invalid_grant","error_description":"grant revoked"}');
		});
		expect(await authStorage.getApiKey("anthropic", "session")).toBeUndefined();

		const notices = await collectDisabledCredentialNotices(authStorage, Date.now());
		expect(notices).toHaveLength(1);
		expect(notices[0]).toContain("anthropic signed-out@example.com was signed out");
		expect(notices[0]).toContain("grant revoked");
		expect(notices[0]).toContain("/login anthropic");
		// A teardown a live notice already announced to the caller is not repeated.
		const [tombstone] = await authStorage.listDisabledCredentials("anthropic");
		if (!tombstone) throw new Error("tombstone missing");
		expect(await collectDisabledCredentialNotices(authStorage, Date.now(), new Set([tombstone.id]))).toEqual([]);

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
		expect(notices[8]).toBe("… 3 more signed-out accounts; see omp usage.");
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
		expect(notice).toMatch(/^Signed out of extension-provider-y+… x+…: /);
		// `/login` matches its argument exactly: a cut id is not offered as one.
		expect(notice).toMatch(/Sign in again with \/login and choose the provider\.$/);
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
		expect(await authStorage.getApiKey("anthropic", "session")).toBeUndefined();

		const [notice] = await collectDisabledCredentialNotices(authStorage, Date.now());
		expect(notice).toContain("whoami@example.com was signed out");
		expect(notice).toContain("revoked!");
		expect(notice).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F]/);
		expect(notice).toContain("/login anthropic");
		expect(
			formatCredentialDisabledNotice({
				provider: "anthropic",
				credentialId: 1,
				credentialType: "oauth",
				email: "who\x1b[2Jami@example.com",
				disabledCause: "oauth refresh failed: grant\trevoked\x1b[31m!",
			}),
		).toMatch(
			/^Signed out of anthropic whoami@example\.com: grant +revoked!\. Sign in again with \/login anthropic\.$/,
		);
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
			// The startup replay runs only once a listener is in place, and is
			// told which live announcements that listener has already seen.
			getDisabledCredentialNotices: async (options?: { announcedAfter?: number }) => {
				if (!notify) throw new Error("replayed before subscribing");
				expect(options?.announcedAfter).toBe(3);
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
		expect(stderrOutput.join("")).toBe(
			"anthropic b@example.com was signed out 5s ago: invalid_grant. Sign in again with /login anthropic.\n" +
				"Working...\nauth: Signed out of anthropic a@example.com\n",
		);
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
		const noticeAt = stderr.indexOf("openai-codex signed-out@example.com was signed out");
		const exitAt = stderr.indexOf("No models available");
		expect(noticeAt, stderr).toBeGreaterThanOrEqual(0);
		expect(exitAt, stderr).toBeGreaterThan(noticeAt);
		expect(stderr).toContain("/login openai-codex");
	}, 60_000);

	it("names the account, the cause, and the way back in for a live teardown", () => {
		expect(
			formatCredentialDisabledNotice({
				provider: "openai-codex",
				credentialId: 16,
				credentialType: "oauth",
				email: "signed-out@example.com",
				orgName: "Example Org",
				disabledCause: "oauth refresh failed: OAuthError: invalid_grant; refresh token expired",
			}),
		).toBe(
			"Signed out of openai-codex signed-out@example.com · Example Org: OAuthError: invalid_grant. Sign in again with /login openai-codex.",
		);
		expect(
			formatCredentialDisabledNotice({
				provider: "kagi",
				credentialId: 2,
				credentialType: "api_key",
				disabledCause: "disabled via auth-broker",
			}),
		).toBe("Signed out of kagi API key: disabled via auth-broker. Sign in again with /login kagi.");
		// A managed MCP OAuth row is not a /login provider: name the server, point at /mcp reauth.
		expect(
			formatCredentialDisabledNotice({
				provider: "mcp_oauth:profile:default:https://mcp.example.com/sse?project_ref=abc",
				credentialId: 3,
				credentialType: "oauth",
				disabledCause: "oauth refresh failed: invalid_grant",
			}),
		).toBe(
			"Signed out of MCP server https://mcp.example.com/sse?project_ref=abc: invalid_grant. Reauthorize it with /mcp reauth <name>.",
		);
	});
});
