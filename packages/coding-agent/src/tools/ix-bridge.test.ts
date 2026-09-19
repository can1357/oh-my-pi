import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { ToolSession } from "./index";
import { createIxBridgeTool } from "./ix-bridge";

let savedKey: string | undefined;

beforeEach(() => {
	savedKey = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "or-key";
});

afterEach(() => {
	if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
	else process.env.OPENROUTER_API_KEY = savedKey;
});

const SNAPSHOT = JSON.stringify({ data: { url: "https://x/confirm", title: "Done" } });
function sessionWithFetch(handler: (url: string, init?: RequestInit) => Response): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		fetch: (async (url: string, init?: RequestInit) => handler(url, init)) as ToolSession["fetch"],
	} as ToolSession;
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map(c => c.text ?? "").join("\n");
}

describe("ix_bridge action=verify", () => {
	it("snapshots the lane, augments with field values, then judges", async () => {
		const urls: string[] = [];
		const bodies: string[] = [];
		const session = sessionWithFetch((url, init) => {
			urls.push(url);
			if (init?.body) bodies.push(init.body as string);
			if (url.includes("/ix-bridge/command")) return new Response(SNAPSHOT, { status: 200 });
			return new Response(
				JSON.stringify({
					choices: [{ message: { content: '{"goal_met": 0.95}' } }],
					usage: { prompt_tokens: 50 },
				}),
				{ status: 200 },
			);
		});
		const tool = createIxBridgeTool(session);
		const result = await tool.execute("t1", { action: "verify", goal: "finish checkout" }, undefined);

		expect(result.isError).toBeFalsy();
		// snapshot → browser_execute(field values) → OpenRouter judge
		expect(urls[0]).toContain("/ix-bridge/command");
		expect(urls[1]).toContain("/ix-bridge/command");
		expect(urls[2]).toContain("openrouter.ai");
		expect(bodies[1]).toContain("browser_execute");
		const judgeBody = JSON.parse(bodies[2]) as { messages: { content: string }[] };
		expect(judgeBody.messages[0].content).toContain("FORM FIELD VALUES");
		const text = textOf(result);
		expect(text).toContain('"verified": true');
		expect(text).toContain("0.95");
	});

	it("reports verified=false below threshold", async () => {
		const session = sessionWithFetch(url =>
			url.includes("/ix-bridge/command")
				? new Response(SNAPSHOT, { status: 200 })
				: new Response(JSON.stringify({ choices: [{ message: { content: '{"goal_met": 0.4}' } }] }), {
						status: 200,
					}),
		);
		const tool = createIxBridgeTool(session);
		const result = await tool.execute("t1", { action: "verify", goal: "g" }, undefined);
		expect(textOf(result)).toContain('"verified": false');
	});

	it("errors without a goal", async () => {
		const tool = createIxBridgeTool(sessionWithFetch(() => new Response("{}", { status: 200 })));
		const result = await tool.execute("t1", { action: "verify" }, undefined);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("goal");
	});

	it("flags uncertain on mid-range probabilities", async () => {
		const session = sessionWithFetch(url =>
			url.includes("/ix-bridge/command")
				? new Response(SNAPSHOT, { status: 200 })
				: new Response(JSON.stringify({ choices: [{ message: { content: '{"goal_met": 0.5}' } }] }), {
						status: 200,
					}),
		);
		const tool = createIxBridgeTool(session);
		const result = await tool.execute("t1", { action: "verify", goal: "g" }, undefined);
		const text = textOf(result);
		expect(text).toContain('"verified": false');
		expect(text).toContain('"uncertain": true');
	});

	it("errors when the snapshot fails", async () => {
		const session = sessionWithFetch(() => new Response("daemon down", { status: 502 }));
		const tool = createIxBridgeTool(session);
		const result = await tool.execute("t1", { action: "verify", goal: "g" }, undefined);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("snapshot failed");
	});

	it("errors when OPENROUTER_API_KEY is unset", async () => {
		delete process.env.OPENROUTER_API_KEY;
		const session = sessionWithFetch(() => new Response(SNAPSHOT, { status: 200 }));
		const tool = createIxBridgeTool(session);
		const result = await tool.execute("t1", { action: "verify", goal: "g" }, undefined);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("OPENROUTER_API_KEY");
	});
});
