/**
 * GitLab Duo authorizes its paid traffic with short-lived tokens GitLab mints:
 * the `direct_access` token the AI gateway proxy takes (cached 25 minutes),
 * and the workflow token a Duo Workflow socket opens with (two hours, stated
 * as `token_expires_at`). A `/pause` (`StreamOptions.beforeDispatch`) lasts as
 * long as a human wants, so a token minted before the hold can be dead when
 * the request it authorizes leaves. Each token is therefore taken, and minted
 * afresh when it has aged out, after the hold has answered.
 */
import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { clearGitLabDuoDirectAccessCache, getGitLabDuoModels } from "@oh-my-pi/pi-ai/providers/gitlab-duo";
import {
	type GitLabDuoWorkflowWebSocketFactory,
	type GitLabDuoWorkflowWebSocketLike,
	streamGitLabDuoWorkflow,
} from "@oh-my-pi/pi-ai/providers/gitlab-duo-workflow";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ProbedGate, resumeUntilSettled } from "./helpers/probed-gate";

const MINUTE_MS = 60_000;
const context: Context = { messages: [{ role: "user", content: "Reply OK", timestamp: 0 }] };

afterEach(() => {
	setSystemTime();
	clearGitLabDuoDirectAccessCache();
});

/**
 * Runs `pending` to the end. Each time the gate is found closed, the clock
 * jumps `pauseMs` forward before it reopens, and the resume is logged: the
 * pause lasted that long.
 */
function resumeAfter<T>(pending: Promise<T>, gate: ProbedGate, pauseMs: number, events: string[]): Promise<T> {
	return resumeUntilSettled(
		pending,
		gate,
		() => true,
		() => {
			setSystemTime(new Date(Date.now() + pauseMs));
			events.push("resume");
		},
	);
}

describe("GitLab Duo direct_access token under a dispatch hold", () => {
	// The token was minted before the request's hold and baked into the routed
	// provider's headers, so a request held past the token's cache lifetime
	// went out with it: mint:token-1, resume, wire:token-1.
	for (const id of ["duo-chat-sonnet-4-5", "duo-chat-gpt-5-1", "duo-chat-gpt-5-codex"]) {
		it(`${id}: sends a token minted after a pause that outlasted the cached one`, async () => {
			const model = getGitLabDuoModels().find(candidate => candidate.id === id);
			if (!model) throw new Error(`GitLab Duo model ${id} is missing`);
			const gate = new ProbedGate();
			const events: string[] = [];
			const sent: { authorization: string | null; instance: string | null }[] = [];
			let mints = 0;
			const fetch: FetchImpl = async (input, init) => {
				if (String(input).includes("/direct_access")) {
					mints++;
					events.push(`mint:token-${mints}`);
					// The pause lands right after the first token is minted.
					if (mints === 1) gate.close();
					return Response.json({
						token: `token-${mints}`,
						headers: { "x-gitlab-instance-id": `instance-${mints}` },
					});
				}
				const headers = new Headers(init?.headers);
				sent.push({ authorization: headers.get("authorization"), instance: headers.get("x-gitlab-instance-id") });
				return Response.json({ error: { message: "stop after the request is seen" } }, { status: 400 });
			};

			await resumeAfter(
				streamSimple(model, context, { apiKey: "gitlab-token", fetch, beforeDispatch: gate.hold }).result(),
				gate,
				30 * MINUTE_MS,
				events,
			);

			expect(sent).toHaveLength(1);
			const token = sent[0]!.authorization?.replace(/^Bearer /, "");
			expect(events).toContain("resume");
			expect(events.indexOf(`mint:${token}`)).toBeGreaterThan(events.lastIndexOf("resume"));
			// The gateway headers that came with the token are the fresh ones too.
			expect(sent[0]!.instance).toBe(`instance-${token?.replace("token-", "")}`);
		});
	}

	// A short pause leaves the cached token good: nothing is minted twice.
	it("reuses the cached token after a pause it outlives", async () => {
		const model = getGitLabDuoModels().find(candidate => candidate.id === "duo-chat-sonnet-4-5")!;
		const gate = new ProbedGate();
		const sent: (string | null)[] = [];
		let mints = 0;
		const fetch: FetchImpl = async (input, init) => {
			if (String(input).includes("/direct_access")) {
				mints++;
				gate.close();
				return Response.json({ token: `token-${mints}`, headers: {} });
			}
			sent.push(new Headers(init?.headers).get("authorization"));
			return Response.json({ error: { message: "stop after the request is seen" } }, { status: 400 });
		};

		await resumeAfter(
			streamSimple(model, context, { apiKey: "gitlab-token", fetch, beforeDispatch: gate.hold }).result(),
			gate,
			MINUTE_MS,
			[],
		);

		expect(mints).toBe(1);
		expect(sent).toEqual(["Bearer token-1"]);
	});
});

describe("GitLab Duo Workflow token under a dispatch hold", () => {
	const workflowModel: Model<"gitlab-duo-agent"> = buildModel({
		id: "claude_sonnet_4_6_vertex",
		name: "Claude Sonnet 4.6 - Vertex",
		api: "gitlab-duo-agent",
		provider: "gitlab-duo-agent",
		baseUrl: "https://gitlab.pause-authorization.example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		supportsTools: true,
	});

	/**
	 * One workflow turn whose socket the first hold guards. The first workflow
	 * token minted closes the gate, so the pause sits between that token and
	 * the socket it opens. `statesExpiry` decides whether GitLab's response
	 * says when its token expires.
	 */
	async function runTurn(
		pauseMs: number,
		statesExpiry: boolean,
	): Promise<{ events: string[]; openedWith: string[]; mints: number }> {
		const gate = new ProbedGate();
		const events: string[] = [];
		const openedWith: string[] = [];
		let mints = 0;
		const fetch: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url.includes("/api/v4/ai/duo_workflows/direct_access")) {
				mints++;
				events.push(`mint:rails-${mints}`);
				if (mints === 1) gate.close();
				const expiry = statesExpiry
					? { token_expires_at: new Date(Date.now() + 120 * MINUTE_MS).toISOString() }
					: {};
				return Response.json({ gitlab_rails: { token: `rails-${mints}`, ...expiry } });
			}
			if (url.includes("/api/v4/ai/duo_workflows/workflows") && init?.method === "POST") {
				return Response.json({ id: "workflow-1" });
			}
			return new Response("{}", { status: 404 });
		};
		const webSocketFactory: GitLabDuoWorkflowWebSocketFactory = (_url, options) => {
			openedWith.push(options.headers.authorization?.replace(/^Bearer /, "") ?? "");
			const socket: GitLabDuoWorkflowWebSocketLike = {
				onopen: null,
				onmessage: null,
				onerror: null,
				onclose: null,
				send() {
					queueMicrotask(() =>
						socket.onmessage?.(
							new MessageEvent("message", { data: JSON.stringify({ status: "INPUT_REQUIRED" }) }),
						),
					);
				},
				close() {},
			};
			queueMicrotask(() => socket.onopen?.(new Event("open")));
			return socket;
		};

		const result = await resumeAfter(
			streamGitLabDuoWorkflow(workflowModel, context, {
				apiKey: "gitlab-token",
				rootNamespaceId: "gid://gitlab/Group/1",
				fetch,
				webSocketFactory,
				beforeDispatch: gate.hold,
			}).result(),
			gate,
			pauseMs,
			events,
		);
		expect(result.stopReason).not.toBe("error");
		return { events, openedWith, mints };
	}

	// The workflow token was minted during setup and the socket opened with it
	// after the hold, however long the hold lasted:
	// mint:rails-1, resume, socket opened with rails-1, two hours dead.
	it("opens the socket with a token minted after a pause that outlasted the stated expiry", async () => {
		const { events, openedWith } = await runTurn(180 * MINUTE_MS, true);

		expect(openedWith).toHaveLength(1);
		expect(events).toContain("resume");
		expect(events.indexOf(`mint:${openedWith[0]}`)).toBeGreaterThan(events.lastIndexOf("resume"));
	});

	it("opens the socket with a token minted after a long pause when GitLab states no expiry", async () => {
		const { events, openedWith } = await runTurn(180 * MINUTE_MS, false);

		expect(openedWith).toHaveLength(1);
		expect(events.indexOf(`mint:${openedWith[0]}`)).toBeGreaterThan(events.lastIndexOf("resume"));
	});

	// A pause well inside the token's life leaves it good: one mint, one socket.
	it("keeps the setup token after a pause it outlives", async () => {
		const { openedWith, mints } = await runTurn(MINUTE_MS, true);

		expect(mints).toBe(1);
		expect(openedWith).toEqual(["rails-1"]);
	});
});
