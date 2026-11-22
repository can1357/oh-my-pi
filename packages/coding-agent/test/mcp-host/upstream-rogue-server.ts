#!/usr/bin/env bun
/**
 * Test fixture: a stdio server that takes 2026-07-28 requests but misbehaves
 * in the two ways a well-formed modern fixture cannot show:
 *
 * - `subscriptions/listen` is never acknowledged and never answered.
 * - The `ask` tool writes a JSON-RPC request (`roots/list`, id `ask-1`) to the
 *   client, which the modern revision forbids, then answers the call.
 *
 * The `frames` tool returns every line received so far, parsed, so a test can
 * see exactly what the client wrote.
 */
import * as readline from "node:readline";

interface Frame {
	id?: string | number;
	method?: string;
	params?: { name?: string };
}

const frames: Frame[] = [];
const write = (frame: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const text = (value: unknown) => ({ resultType: "complete", content: [{ type: "text", text: JSON.stringify(value) }] });

if (import.meta.main) {
	const lines = readline.createInterface({ input: process.stdin });
	lines.on("line", line => {
		if (line.trim().length === 0) return;
		const frame = JSON.parse(line) as Frame;
		frames.push(frame);
		if (frame.id === undefined || frame.method !== "tools/call") return;
		if (frame.params?.name === "ask") write({ jsonrpc: "2.0", id: "ask-1", method: "roots/list" });
		write({ jsonrpc: "2.0", id: frame.id, result: text(frame.params?.name === "frames" ? frames : null) });
	});
	lines.on("close", () => process.exit(0));
}
