import { describe, expect, it } from "bun:test";

import { CaptureHttpRouter } from "../src/capture/http";
import { CaptureOrchestrator } from "../src/capture/orchestrator";
import { baseRequest, createTestStore, FakeRunnerAdapter, waitFor } from "./helpers/capture-fakes";

function setup(options: { gatewayToken?: string } = {}) {
	const { store } = createTestStore();
	const runner = new FakeRunnerAdapter();
	const orchestrator = new CaptureOrchestrator({ store, runner });
	const router = new CaptureHttpRouter({ orchestrator, gatewayToken: options.gatewayToken });
	return { store, runner, orchestrator, router };
}

function request(path: string, options: RequestInit = {}): Request {
	return new Request(`http://127.0.0.1:18087${path}`, options);
}

function postJson(path: string, body: unknown, headers: Record<string, string> = {}): Request {
	return request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body),
	});
}

async function handle(router: CaptureHttpRouter, req: Request): Promise<Response> {
	const response = await router.handle(req, new URL(req.url).pathname);
	if (!response) throw new Error("route not handled");
	return response;
}

describe("CaptureHttpRouter", () => {
	it("accepts a valid capture task and returns 202", async () => {
		const { router, runner } = setup();
		const response = await handle(router, postJson("/api/capture/tasks", baseRequest()));
		expect(response.status).toBe(202);
		const body = (await response.json()) as { task: { id: string; status: string } };
		expect(body.task.id).toBeDefined();
		await waitFor(() => runner.dispatches.length === 1);
		runner.finish("ok");
	});

	it("rejects invalid payloads with 400", async () => {
		const { router } = setup();
		const response = await handle(router, postJson("/api/capture/tasks", { instruction: "missing fields" }));
		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: string };
		expect(body.error).toContain("requestId");
	});

	it("never exposes session file paths", async () => {
		const { router, runner, store } = setup();
		const create = await handle(router, postJson("/api/capture/tasks", baseRequest()));
		const created = (await create.json()) as { task: { id: string } };
		await waitFor(() => runner.dispatches.length === 1);
		runner.finish("ok");
		await waitFor(() => store.getRun(created.task.id)?.status === "completed");

		const get = await handle(router, request(`/api/capture/tasks/${created.task.id}`));
		const body = await get.text();
		expect(get.status).toBe(200);
		expect(body).not.toContain("sessionFile");
		expect(body).not.toContain("/fake/sessions");
		expect(body).toContain("session-1");
	});

	it("requires the bearer token when configured", async () => {
		const { router } = setup({ gatewayToken: "capture-token" });
		const denied = await handle(router, postJson("/api/capture/tasks", baseRequest()));
		expect(denied.status).toBe(401);
		const allowed = await handle(
			router,
			postJson("/api/capture/tasks", baseRequest(), { Authorization: "Bearer capture-token" }),
		);
		expect(allowed.status).toBe(202);
	});

	it("serves follow-up and cancel endpoints", async () => {
		const { router, runner, store } = setup();
		const create = await handle(router, postJson("/api/capture/tasks", baseRequest()));
		const created = (await create.json()) as { task: { id: string } };
		await waitFor(() => runner.dispatches.length === 1);
		runner.finish("first");
		await waitFor(() => store.getRun(created.task.id)?.status === "completed");

		const followUp = await handle(
			router,
			postJson(`/api/capture/tasks/${created.task.id}/follow-up`, { text: "and now the tests" }),
		);
		expect(followUp.status).toBe(202);
		await waitFor(() => runner.dispatches.length === 2);

		const cancel = await handle(router, request(`/api/capture/tasks/${created.task.id}/cancel`, { method: "POST" }));
		expect(cancel.status).toBe(200);
		await waitFor(() => store.getRun(created.task.id)?.status === "cancelled");
	});

	it("returns 404 for unknown tasks and invalid ids", async () => {
		const { router } = setup();
		expect((await handle(router, request(`/api/capture/tasks/${crypto.randomUUID()}`))).status).toBe(404);
		expect((await handle(router, request("/api/capture/tasks/..%2Fescape"))).status).toBe(400);
		expect(
			(await handle(router, postJson(`/api/capture/tasks/${crypto.randomUUID()}/follow-up`, { text: "x" }))).status,
		).toBe(404);
	});

	it("lists runners and sessions", async () => {
		const { router, runner, store } = setup();
		const create = await handle(router, postJson("/api/capture/tasks", baseRequest()));
		const created = (await create.json()) as { task: { id: string } };
		await waitFor(() => runner.dispatches.length === 1);
		runner.finish("done");
		await waitFor(() => store.getRun(created.task.id)?.status === "completed");

		const runners = (await (await handle(router, request("/api/capture/runners"))).json()) as {
			runners: Array<{ id: string }>;
		};
		expect(runners.runners.map(r => r.id)).toContain("msi-windows-main");

		const sessions = (await (await handle(router, request("/api/capture/sessions"))).json()) as {
			sessions: Array<{ sessionId: string }>;
		};
		expect(sessions.sessions.map(s => s.sessionId)).toContain("session-1");
	});

	it("streams run events over SSE", async () => {
		const { router, runner } = setup();
		const create = await handle(router, postJson("/api/capture/tasks", baseRequest()));
		const created = (await create.json()) as { task: { id: string } };
		await waitFor(() => runner.dispatches.length === 1);

		const eventsResponse = await handle(router, request(`/api/capture/events/${created.task.id}`));
		expect(eventsResponse.headers.get("Content-Type")).toBe("text/event-stream");
		runner.finish("streamed");
		const body = await eventsResponse.text();
		expect(body).toContain('"type":"run.status"');
		expect(body).toContain('"status":"completed"');
		expect(body).toContain("event: end");
	});

	it("does not handle non-capture paths", async () => {
		const { router } = setup();
		expect(await router.handle(request("/api/capture"), "/api/capture")).toBeUndefined();
		expect(await router.handle(request("/api/other"), "/api/other")).toBeUndefined();
	});
});
