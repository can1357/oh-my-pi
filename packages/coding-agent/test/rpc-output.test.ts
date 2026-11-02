import { afterEach, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Writable } from "node:stream";
import { TempDir } from "@oh-my-pi/pi-utils";
import { RpcFrameDecoder, RpcFrameEncoder } from "../src/modes/rpc/rpc-frame";
import { RpcOutputWriter } from "../src/modes/rpc/rpc-output";

afterEach(() => {
	mock.restore();
});

it("drains RPC command responses after stdin EOF while the real stdout pipe is backpressured", async () => {
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "../src/cli.ts"),
			"--mode",
			"rpc",
			"--no-extensions",
			"--no-skills",
			"--no-tools",
			"--no-session",
			"--provider",
			"anthropic",
			"--model",
			"claude-sonnet-4-5",
		],
		{
			cwd: import.meta.dir,
			env: { ...process.env, PI_NO_TITLE: "1" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderr = new Response(child.stderr).text();
	const reader = child.stdout.getReader();
	const chunks: Uint8Array[] = [];
	try {
		const ready = await reader.read();
		if (ready.done) throw new Error(`RPC exited before ready: ${await stderr}`);
		chunks.push(ready.value);
		for (let id = 0; id < 128; id++) {
			child.stdin.write(`${JSON.stringify({ type: "get_state", id: `${id}:${"x".repeat(32768)}` })}\n`);
		}
		await child.stdin.flush();
		child.stdin.end();
		await Bun.sleep(300);
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			chunks.push(next.value);
		}
		const output = Buffer.concat(chunks).toString();
		const replies: { id: string; type: string; success?: boolean }[] = output
			.trimEnd()
			.split("\n")
			.map(line => JSON.parse(line));
		expect(replies.filter(reply => reply.type === "response").map(reply => reply.id.split(":")[0])).toEqual(
			Array.from({ length: 128 }, (_, id) => String(id)),
		);
		expect(await child.exited).toBe(0);
	} finally {
		reader.releaseLock();
		child.kill();
		await child.exited.catch(() => {});
		await stderr;
	}
}, 30_000);

it("delivers ordered v1 and chunked v2 frames through a slow sink before close completes", async () => {
	const chunks: Buffer[] = [];
	const sink = new Writable({
		highWaterMark: 1024,
		write(chunk, _encoding, callback) {
			chunks.push(Buffer.from(chunk));
			void Bun.sleep(1).then(() => callback());
		},
	});
	const errors: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => errors.push(error));
	const encoder = new RpcFrameEncoder();
	const expected: object[] = [{ type: "ready" }, { type: "response", command: "negotiate_protocol", success: true }];
	for (const frame of expected) writer.write(encoder.encodeFrames(frame));
	encoder.setProtocolVersion(2);
	for (let id = 0; id < 32; id++) {
		const frame = { type: "response", id, data: `${id}:${"🌍".repeat(id === 4 ? 300_000 : 8192)}` };
		expected.push(frame);
		writer.write(encoder.encodeFrames(frame));
	}
	const final = { type: "agent_end", messages: [] };
	expected.push(final);
	writer.write(encoder.encodeFrames(final));
	await writer.close();
	const decoder = new RpcFrameDecoder();
	const actual = Buffer.concat(chunks)
		.toString()
		.trimEnd()
		.split("\n")
		.map(line => decoder.push(JSON.parse(line)))
		.filter(frame => frame !== undefined);
	expect(actual).toEqual(expected);
	expect(errors).toEqual([]);
});

it("fails promptly and removes spilled output when the reader disconnects", async () => {
	await using dir = await TempDir.create("@rpc-output-disconnect-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	const sink = new Writable({ highWaterMark: 1, write() {} });
	const failure = Promise.withResolvers<Error>();
	const writer = new RpcOutputWriter(sink, failure.resolve);
	writer.write(["first\n", "pending\n"]);
	const closed = writer.close();
	sink.destroy(new Error("reader disconnected"));
	await expect(closed).rejects.toThrow("reader disconnected");
	expect((await failure.promise).message).toBe("reader disconnected");
	expect(await Bun.file(dir.join("output")).exists()).toBe(false);
});

it("reports disk exhaustion and removes the partial spool instead of silently dropping accepted output", async () => {
	await using dir = await TempDir.create("@rpc-output-enospc-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	spyOn(fs, "writeSync").mockImplementation(() => {
		throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
	});
	const sink = new Writable({ highWaterMark: 1, write() {} });
	const failures: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => failures.push(error));
	writer.write(["first\n", "pending\n"]);
	await expect(writer.close()).rejects.toThrow("disk full");
	expect(failures.map(error => error.message)).toEqual(["disk full"]);
	expect(await Bun.file(dir.join("output")).exists()).toBe(false);
	sink.destroy();
});

it("reports a truncated spool during delivery instead of completing a partial protocol stream", async () => {
	await using dir = await TempDir.create("@rpc-output-truncated-");
	spyOn(TempDir, "createSync").mockReturnValue(dir);
	let release: (() => void) | undefined;
	const sink = new Writable({
		highWaterMark: 1,
		write(_chunk, _encoding, callback) {
			release = callback;
		},
	});
	const failures: Error[] = [];
	const writer = new RpcOutputWriter(sink, error => failures.push(error));
	writer.write(["first\n", "pending\n"]);
	const closed = writer.close();
	fs.truncateSync(dir.join("output"), 0);
	release?.();
	await expect(closed).rejects.toThrow("spool ended before delivery completed");
	expect(failures.map(error => error.message)).toEqual(["RPC output spool ended before delivery completed"]);
	expect(await Bun.file(dir.join("output")).exists()).toBe(false);
	sink.destroy();
});
