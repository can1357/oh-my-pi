import { expect, test } from "bun:test";
import * as path from "node:path";
import type { AgentRunRequest, UserMessage } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";

test("public Cursor dispatch serializes fresh run IDs, flags and hook replacements into the matching request header", async () => {
	// Keep the public registry and auth/transport initialization independent of
	// other files' login mocks; assertions still inspect real HTTP/2 wire bytes.
	const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures/cursor-run-identity-wire.ts")], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(exitCode).toBe(0);
	expect(stderr).toBe("");
	const received = JSON.parse(stdout) as { run: AgentRunRequest; requestId: string; userMessage?: UserMessage }[];
	expect(received).toHaveLength(3);
	const [first, second, replaced] = received;
	expect(first.run.runId).toMatch(/^[0-9a-f-]{36}$/);
	expect(second.run.runId).not.toBe(first.run.runId);
	expect(first.run.clientSupportsInlineImages).toBe(true);
	expect(first.run.clientSupportsRoutedModelUpdate).toBe(true);
	expect(first.run.clientSupportsPromptContextUsageRpc).toBe(true);
	expect(first.run.agentSessionId).toBe("wire-session");
	expect(second.run.clientSupportsInlineImages).toBe(false);
	const conversationId = first.run.conversationId;
	if (typeof conversationId !== "string" || !conversationId) throw new Error("Wire conversation ID missing");
	expect(first.run.conversationGroupId).toBe(conversationId);
	expect(second.run.conversationGroupId).toBe(first.run.conversationGroupId);
	expect(replaced.run.runId).toBe("hook-run");
	for (const row of received) {
		expect(row.requestId).toBe(row.run.runId);
		expect(row.userMessage?.text).toBe("fixture");
		expect(row.userMessage?.mode).toBe(1);
	}
}, 30000);
