import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import {
	buildOmpLaunchArgv,
	createOmpProcessExecutor,
	type OmpProcessJobPayload,
	parseOmpProcessJobPayload,
	resolveOmpSelfCommand,
} from "../../src/operational/omp-process-executor";
import type { DurableJob, JsonValue } from "../../src/operational/types";

function makeJob(payload: JsonValue, id = "job-1"): DurableJob {
	const now = Date.now();
	return {
		id,
		type: "omp",
		status: "running",
		payload,
		result: null,
		error: null,
		leaseOwner: "worker-1",
		leaseExpiresAt: now + 60_000,
		checkpoint: null,
		scheduleId: null,
		createdAt: now,
		updatedAt: now,
		startedAt: now,
		completedAt: null,
	};
}

describe("omp process executor helpers", () => {
	it("parses valid payloads and rejects unknown/invalid shapes", () => {
		const parsed = parseOmpProcessJobPayload({
			prompt: "do work",
			cwd: ".",
			model: "fast",
			approvalMode: "write",
		});
		expect(parsed.prompt).toBe("do work");
		expect(parsed.model).toBe("fast");
		expect(parsed.approvalMode).toBe("write");
		expect(path.isAbsolute(parsed.cwd)).toBe(true);

		expect(() => parseOmpProcessJobPayload({ prompt: "x" })).toThrow(/cwd/);
		expect(() =>
			parseOmpProcessJobPayload({
				prompt: "x",
				cwd: ".",
				extra: true,
			} as unknown as JsonValue),
		).toThrow(/unknown field/);
		expect(() =>
			parseOmpProcessJobPayload({
				prompt: "x",
				cwd: ".",
				approvalMode: "nope",
			}),
		).toThrow(/approvalMode/);
	});

	it("resolves source vs compiled self commands", () => {
		expect(
			resolveOmpSelfCommand({
				isCompiled: true,
				execPath: "C:/omp.exe",
				entryPath: "C:/ignored.ts",
			}),
		).toEqual(["C:/omp.exe"]);

		expect(
			resolveOmpSelfCommand({
				isCompiled: false,
				execPath: "C:/bun.exe",
				entryPath: "C:/cli.ts",
			}),
		).toEqual(["C:/bun.exe", "C:/cli.ts"]);
	});

	it("builds launch --print argv and resume argv with fixed resume prompt", () => {
		const payload: OmpProcessJobPayload = {
			prompt: "original prompt",
			cwd: "C:/proj",
			model: "sonnet",
			approvalMode: "yolo",
		};
		const fresh = buildOmpLaunchArgv({
			command: ["omp"],
			payload,
			sessionDir: "C:/sessions/job",
		});
		expect(fresh).toEqual([
			"omp",
			"launch",
			"--print",
			"--cwd",
			"C:/proj",
			"--session-dir",
			"C:/sessions/job",
			"--approval-mode",
			"yolo",
			"--model",
			"sonnet",
			"--",
			"original prompt",
		]);

		const resumed = buildOmpLaunchArgv({
			command: ["omp"],
			payload,
			sessionDir: "C:/sessions/job",
			resumeSessionFile: "C:/sessions/job/a.jsonl",
			resumePromptText: "RESUME_MARK",
		});
		expect(resumed).toContain("--resume");
		expect(resumed).toContain("C:/sessions/job/a.jsonl");
		expect(resumed.at(-1)).toBe("RESUME_MARK");
		expect(resumed.includes("original prompt")).toBe(false);
	});
});

describe("omp process executor runtime", () => {
	let tempDir: TempDir | undefined;

	afterEach(async () => {
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {
				// ignore cleanup races on Windows
			}
			tempDir = undefined;
		}
	});

	it("checkpoints session file, respects output bounds, and throws after nonzero exit", async () => {
		tempDir = await TempDir.create("@omp-exec-");
		const sessionDir = path.join(tempDir.path(), "sessions");
		const sessionFile = path.join(sessionDir, "run.jsonl");

		const captured: string[][] = [];
		const executor = createOmpProcessExecutor({
			command: ["fake-omp"],
			maxOutputBytes: 8,
			heartbeatIntervalMs: 20,
			discoverSessionFile: async () => sessionFile,
			createSessionDir: () => sessionDir,
			spawn: ((opts: { cmd: string[] }) => {
				captured.push([...opts.cmd]);
				void Bun.write(sessionFile, '{"type":"session"}\n');
				const stdout = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(Buffer.from("abcdefghij"));
						controller.close();
					},
				});
				const stderr = new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(Buffer.from("err"));
						controller.close();
					},
				});
				return {
					stdout,
					stderr,
					exited: Promise.resolve(2),
					kill() {},
				};
			}) as unknown as typeof Bun.spawn,
		});

		const checkpoints: JsonValue[] = [];
		const payload = {
			prompt: "hello",
			cwd: tempDir.path(),
		};

		await expect(
			executor({
				job: makeJob(payload),
				signal: new AbortController().signal,
				checkpoint: null,
				checkpointWrite: data => {
					checkpoints.push(data);
				},
				heartbeat: () => true,
			}),
		).rejects.toThrow(/exited with code 2/);

		expect(captured[0]?.includes("launch")).toBe(true);
		expect(captured[0]?.includes("--print")).toBe(true);
		expect(checkpoints.some(c => typeof c === "object" && c !== null && "sessionFile" in c)).toBe(true);
	});

	it("uses --resume with checkpoint and aborts the child process", async () => {
		tempDir = await TempDir.create("@omp-exec-abort-");
		const sessionDir = tempDir.path();
		const sessionFile = path.join(sessionDir, "prior.jsonl");
		await Bun.write(sessionFile, String.fromCharCode(123, 125, 10));

		let killed = false;
		let seenArgv: string[] = [];
		const controller = new AbortController();

		const executor = createOmpProcessExecutor({
			command: ["fake-omp"],
			heartbeatIntervalMs: 50,
			discoverSessionFile: async () => sessionFile,
			createSessionDir: () => sessionDir,
			spawn: ((opts: { cmd: string[] }) => {
				seenArgv = [...opts.cmd];
				const exit = Promise.withResolvers<number>();
				const exited = exit.promise;
				queueMicrotask(() => controller.abort());
				return {
					stdout: new ReadableStream<Uint8Array>({
						async start(c) {
							await exited;
							c.close();
						},
					}),
					stderr: new ReadableStream<Uint8Array>({
						async start(c) {
							await exited;
							c.close();
						},
					}),
					exited,
					kill() {
						killed = true;
						exit.resolve(1);
					},
				};
			}) as unknown as typeof Bun.spawn,
		});

		await expect(
			executor({
				job: makeJob({ prompt: "original", cwd: tempDir.path() }),
				signal: controller.signal,
				checkpoint: { sessionFile },
				checkpointWrite: () => {},
				heartbeat: () => true,
			}),
		).rejects.toThrow();

		expect(seenArgv.includes("--resume")).toBe(true);
		expect(seenArgv.includes(path.resolve(sessionFile))).toBe(true);
		expect(seenArgv.includes("original")).toBe(false);
		expect(killed).toBe(true);
	});

	it("truncates oversized stdout capture", async () => {
		tempDir = await TempDir.create("@omp-exec-bounds-");
		const sessionDir = path.join(tempDir.path(), "sessions");

		const executor = createOmpProcessExecutor({
			command: ["fake-omp"],
			maxOutputBytes: 4,
			discoverSessionFile: async () => null,
			createSessionDir: () => sessionDir,
			spawn: (() => {
				return {
					stdout: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.enqueue(Buffer.from("1234567890"));
							controller.close();
						},
					}),
					stderr: new ReadableStream<Uint8Array>({
						start(controller) {
							controller.close();
						},
					}),
					exited: Promise.resolve(0),
					kill() {},
				};
			}) as unknown as typeof Bun.spawn,
		});

		const result = await executor({
			job: makeJob({ prompt: "p", cwd: tempDir.path() }),
			signal: new AbortController().signal,
			checkpoint: null,
			checkpointWrite: () => {},
			heartbeat: () => true,
		});

		expect(result).toMatchObject({
			exitCode: 0,
			stdoutTruncated: true,
			stdoutBytes: 4,
		});
		expect(typeof result === "object" && result && "stdout" in result && result.stdout).toBe("1234");
	});
});
