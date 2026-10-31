/**
 * `/security cloud` runs against a session, outside any turn, so its Codex Security cloud requests
 * live no longer than that session: they carry its disposal signal, joined to the host's
 * cancellation. The command used to pass no signal at all, so a credential lookup that finished
 * while the session was disposing still sent the authenticated request: for `cloud start`, the
 * POST that creates a scan and spends cloud scan allowance.
 *
 * Counted at a local endpoint. The credential lookup resolves the real stored OAuth row, then holds
 * its result while the session stops, the way a slow token refresh that ignores cancellation would.
 *
 * The endpoint speaks HTTPS on `localhost`, as `https://chatgpt.com` does. The fixture takes
 * production's branch: the command builds its client with no `fetch` of its own, so the client sends
 * through `globalThis.fetch` over HTTPS, with no proxy. One property differs from production and
 * cannot match it: the client's base URL is fixed to ChatGPT, so the global fetch the client captures
 * is a stand-in that sends each ChatGPT request, with the same init, to the local endpoint instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { handleSecurityCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/security";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "../helpers/agent-session-setup";
import { LOOPBACK_TLS, loopbackOrigin, trustLoopbackTls } from "../helpers/loopback-tls";

const CLOUD_ORIGIN = "https://chatgpt.com";
const CLOUD_PATH = "/backend-api/aardvark/";
/** A ChatGPT access token: the scan's owner id is the JWT subject. */
const ACCESS_TOKEN = `header.${Buffer.from(JSON.stringify({ sub: "user-a" })).toString("base64url")}.signature`;

/** Each `/security cloud` subcommand, with the arguments that reach its first cloud request. */
const SUBCOMMANDS = {
	scans: "cloud scans",
	start: "cloud start --repo-id repo-a --repo-url https://github.com/example/repository --environment env-a",
	status: "cloud status config-a",
	pull: "cloud pull config-a",
} as const;

type Stop = "none" | "beginDispose" | "dispose";

describe("/security cloud at session disposal", () => {
	let tempDir: TempDir;
	let server: Bun.Server<undefined>;
	let authStorage: AuthStorage;
	let session: AgentSession;
	/** For each request the cloud endpoint received: its method, path, and whether the session was disposing. */
	let requests: Array<{ method: string; path: string; disposing: boolean }>;
	let credentialReached: PromiseWithResolvers<void>;
	let releaseCredential: PromiseWithResolvers<void>;

	trustLoopbackTls();

	beforeEach(async () => {
		tempDir = TempDir.createSync("@omp-security-cloud-dispose-");
		requests = [];
		credentialReached = Promise.withResolvers<void>();
		releaseCredential = Promise.withResolvers<void>();
		server = Bun.serve({
			...LOOPBACK_TLS,
			port: 0,
			fetch: async request => {
				if (request.method === "POST") await request.json();
				requests.push({
					method: request.method,
					path: new URL(request.url).pathname,
					disposing: session.isDisposed,
				});
				// One body serves every endpoint: a scan configuration, an empty configuration page, and stats.
				return Response.json({
					id: "config-a",
					items: [],
					scan_input: {
						repo_id: "repo-a",
						repo_url: "https://github.com/example/repository",
						environment_id: "env-a",
					},
				});
			},
		});
		// The cloud client sends to its fixed ChatGPT base URL; deliver those requests to the local endpoint.
		const realFetch = globalThis.fetch;
		vi.spyOn(globalThis, "fetch").mockImplementation(((input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(input instanceof Request ? input.url : String(input));
			if (url.origin !== CLOUD_ORIGIN || !url.pathname.startsWith(CLOUD_PATH)) {
				throw new Error(`Unexpected request to ${url}`);
			}
			return realFetch(new URL(`${url.pathname}${url.search}`, loopbackOrigin(server)), init);
		}) as typeof fetch);

		authStorage = createInMemoryAuthStorage();
		await authStorage.credentials.set("openai-codex", [
			{ type: "oauth", access: ACCESS_TOKEN, refresh: "refresh-a", expires: Date.now() + 3_600_000 },
		]);
		const accessById = authStorage.oauth.accessById.bind(authStorage.oauth);
		vi.spyOn(authStorage.oauth, "accessById").mockImplementation(async (...args) => {
			const resolution = await accessById(...args);
			credentialReached.resolve();
			await releaseCredential.promise;
			return resolution;
		});

		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		session = new AgentSession({
			agent: new Agent({ getApiKey: () => "test-key", initialState: { model, systemPrompt: ["Test"], tools: [] } }),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			settings: Settings.isolated({ "compaction.enabled": false, "security.enabled": true }),
		});
	});

	afterEach(async () => {
		releaseCredential.resolve();
		await session.dispose();
		authStorage.close();
		server.stop(true);
		vi.restoreAllMocks();
		tempDir.removeSync();
	});

	/** Runs `/security <args>`, stops the session as `stop` says while its credential is held, then releases it. */
	async function run(args: string, stop: Stop): Promise<string[]> {
		const outputs: string[] = [];
		const running = handleSecurityCommand(
			{ name: "security", args, text: `/security ${args}` },
			{
				session,
				sessionManager: session.sessionManager,
				settings: session.settings,
				cwd: tempDir.path(),
				output: text => {
					outputs.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			},
		);
		await credentialReached.promise;
		if (stop === "beginDispose") session.beginDispose();
		if (stop === "dispose") await session.dispose();
		releaseCredential.resolve();
		await running;
		return outputs;
	}

	for (const [subcommand, args] of Object.entries(SUBCOMMANDS)) {
		it(`sends the ${subcommand} request on a live session`, async () => {
			await run(args, "none");

			expect(requests).toHaveLength(1);
			expect(requests[0]!.disposing).toBe(false);
		});

		it(`sends no ${subcommand} request once the session begins disposing`, async () => {
			const outputs = await run(args, "beginDispose");

			expect(requests).toEqual([]);
			expect(outputs.at(-1)).toStartWith("Security: ");
		});

		it(`sends no ${subcommand} request after the session's dispose() has returned`, async () => {
			const outputs = await run(args, "dispose");

			expect(requests).toEqual([]);
			expect(outputs.at(-1)).toStartWith("Security: ");
		});
	}

	it("creates the scan on a live session", async () => {
		const outputs = await run(SUBCOMMANDS.start, "none");

		expect(requests).toEqual([{ method: "POST", path: `${CLOUD_PATH}scan_configurations`, disposing: false }]);
		expect(outputs.at(-1)).toContain("Codex Security cloud scan config-a started");
	});

	it("stops with the host's cancellation on a live session", async () => {
		const host = new AbortController();
		const outputs: string[] = [];
		const running = handleSecurityCommand(
			{ name: "security", args: SUBCOMMANDS.start, text: `/security ${SUBCOMMANDS.start}` },
			{
				session,
				sessionManager: session.sessionManager,
				settings: session.settings,
				cwd: tempDir.path(),
				signal: host.signal,
				output: text => {
					outputs.push(text);
				},
				refreshCommands: () => {},
				reloadPlugins: async () => {},
			},
		);
		await credentialReached.promise;
		host.abort();
		releaseCredential.resolve();
		await running;

		expect(requests).toEqual([]);
		expect(session.isDisposed).toBe(false);
		expect(outputs.at(-1)).toStartWith("Security: ");
	});
});
