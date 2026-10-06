import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { createBrowserPrelude } from "@oh-my-pi/pi-coding-agent/tools/browser";
import { releaseAllTabs } from "@oh-my-pi/pi-coding-agent/tools/browser/tab-supervisor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools/index";
import { chromiumAvailable } from "./chromium-probe";

const CHROMIUM_AVAILABLE = await chromiumAvailable();
const GATE_HTML = `<!doctype html><title>Gate page</title><h1>Sign in</h1>`;

let gateUrl = "";

function makeSession(askTool?: AgentTool): ToolSession {
	const session: ToolSession = {
		cwd: tempDir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({
			"browser.enabled": true,
			"browser.headless": true,
			"browser.cmux": false,
			"browser.tern": false,
			"tools.maxTimeout": 0,
		}),
	};
	if (askTool) session.getToolByName = name => (name === "ask" ? askTool : undefined);
	return session;
}

/** Records the args userGate forwarded and answers with a canned ask result text. */
function fakeAskTool(answerText: string, seen: unknown[]): AgentTool {
	return {
		name: "ask",
		label: "ask",
		description: "fake ask",
		parameters: type({
			questions: type.array(
				type({
					id: "string",
					question: "string",
					options: type.array(type({ label: "string" })),
				}),
			),
		}),
		concurrency: "parallel",
		execute: async (_id: string, args: unknown) => {
			seen.push(args);
			return { content: [{ type: "text" as const, text: answerText }] };
		},
	} as unknown as AgentTool;
}

function valueFrom<T>(result: { details?: unknown }): T {
	const details = result.details;
	if (!details || typeof details !== "object") throw new Error("Browser result did not include details");
	return ("value" in details ? details.value : undefined) as T;
}

let tempDir = "";
let server: Bun.Server<unknown> | undefined;

beforeAll(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-browser-user-gate-"));
	// A real origin: pushState is refused on data: URLs, and the gate's
	// fresh-URL read needs a navigation the user could have made.
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(GATE_HTML, { headers: { "content-type": "text/html" } }),
	});
	gateUrl = `http://127.0.0.1:${server.port}/gate`;
});

afterAll(async () => {
	await releaseAllTabs({ kill: true });
	await disposeAllVmContexts();
	server?.stop(true);
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("browser tab userGate", () => {
	test("forwards the gate through the ask tool and resolves with the post-resume URL", async () => {
		const seen: unknown[] = [];
		const session = makeSession(fakeAskTool('gate: "Continue"', seen));
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-user-gate-continue" };
		const tabName = `gate-continue-${crypto.randomUUID()}`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: gateUrl },
			context,
		);
		try {
			// The user's navigation must land before the ask answer resolves; firing
			// the pushState concurrently let userGate's fresh-URL read race it (this
			// failed under full-suite load).
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `await tab.evaluate(() => { history.pushState(null, "", "#after-login"); });
const gate = await tab.userGate("complete 2FA");
return gate;`,
					timeout: 15,
				},
				context,
			);
			const gate = valueFrom<{ url: string; title: string; resumedAt: string }>(result);
			expect(gate.url).toContain("#after-login");
			expect(gate.title).toBe("Gate page");
			expect(Number.isNaN(Date.parse(gate.resumedAt))).toBe(false);

			expect(seen.length).toBe(1);
			const question = (seen[0] as { questions: Array<{ question: string; options: Array<{ label: string }> }> })
				.questions[0];
			expect(question.question).toContain("Gate page");
			expect(question.question).toContain("complete 2FA");
			expect(question.question).toContain("Switch to the tab");
			expect(question.options.map(o => o.label)).toEqual(["Continue", "Cancel"]);
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("Cancel answers reject naming the tab and reason", async () => {
		const session = makeSession(fakeAskTool('gate: "Cancel"', []));
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-user-gate-cancel" };
		const tabName = `gate-cancel-${crypto.randomUUID()}`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: gateUrl },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `try {
	await tab.userGate("complete 2FA");
	return "resolved";
} catch (error) {
	return error instanceof Error ? error.message : String(error);
}`,
					timeout: 15,
				},
				context,
			);
			const message = valueFrom<string>(result);
			expect(message).toContain("cancelled");
			expect(message).toContain(tabName);
			expect(message).toContain("complete 2FA");
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);

	test("without an ask tool it fails with guidance instead of waiting", async () => {
		const session = makeSession();
		const prelude = createBrowserPrelude(session);
		const context = { session, toolCallId: "browser-user-gate-noui" };
		const tabName = `gate-noui-${crypto.randomUUID()}`;
		await prelude.invoke(
			{ action: "open", name: tabName, url: gateUrl },
			context,
		);
		try {
			const result = await prelude.invoke(
				{
					action: "run",
					name: tabName,
					code: `try {
	await tab.userGate("complete 2FA");
	return "resolved";
} catch (error) {
	return error instanceof Error ? error.message : String(error);
}`,
					timeout: 15,
				},
				context,
			);
			const message = valueFrom<string>(result);
			expect(message).toContain("tab.userGate()");
			expect(message).toContain("ask tool");
		} finally {
			await prelude.invoke({ action: "close", name: tabName, kill: true }, context).catch(() => undefined);
		}
	}, 30_000);
});
