/**
 * End-to-end exercise of the subprocess-backed Ruby runner.
 *
 * Gated by `PI_RUBY_INTEGRATION=1` so CI without a real Ruby interpreter
 * (or sandboxes where subprocess spawning is restricted) does not fail.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { disposeAllRubyKernelSessions, executeRubyWithKernel } from "@pk-nerdsaver-ai/pi-coding-agent/eval/rb/executor";
import { RubyKernel } from "@pk-nerdsaver-ai/pi-coding-agent/eval/rb/kernel";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

const SHOULD_RUN = Bun.env.PI_RUBY_INTEGRATION === "1";

describe.skipIf(!SHOULD_RUN)("ruby runner subprocess", () => {
	afterEach(async () => {
		await disposeAllRubyKernelSessions();
	});

	it("streams stdout chunks as they are produced", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-stream-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const chunks: string[] = [];
			const result = await executeRubyWithKernel(kernel, "5.times { |i| puts i }", {
				onChunk: chunk => {
					chunks.push(chunk);
				},
			});
			expect(result.exitCode).toBe(0);
			expect(chunks.join("")).toContain("0\n");
			expect(chunks.join("")).toContain("4\n");
		} finally {
			await kernel.shutdown();
		}
	});

	it("keeps local variables across cells on one kernel", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-state-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const first = await executeRubyWithKernel(kernel, "x = 41", {});
			expect(first.exitCode).toBe(0);
			const second = await executeRubyWithKernel(kernel, "x + 1", {});
			expect(second.exitCode).toBe(0);
			expect(second.output).toContain("42");
		} finally {
			await kernel.shutdown();
		}
	});

	it("auto-displays the last expression but suppresses assignments", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-display-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const assigned = await executeRubyWithKernel(kernel, "y = { a: 1, b: [2, 3] }", {});
			expect(assigned.displayOutputs).toHaveLength(0);

			const expr = await executeRubyWithKernel(kernel, "y", {});
			const json = expr.displayOutputs.find(o => o.type === "json");
			expect(json).toBeDefined();
			if (json?.type === "json") {
				expect(json.data).toEqual({ a: 1, b: [2, 3] });
			}
		} finally {
			await kernel.shutdown();
		}
	});

	it("cancels a running cell via signal and keeps the kernel usable", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-cancel-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const controller = new AbortController();
			// Real delay: this interrupts a live OS subprocess mid-`sleep`, which runs on
			// the platform clock — fake timers cannot drive it. Abort once the cell is in flight.
			setTimeout(() => controller.abort(), 300);
			const cancelled = await executeRubyWithKernel(kernel, "sleep 30", { signal: controller.signal });
			expect(cancelled.cancelled).toBe(true);

			const after = await executeRubyWithKernel(kernel, "20 + 22", {});
			expect(after.exitCode).toBe(0);
			expect(after.output).toContain("42");
		} finally {
			await kernel.shutdown();
		}
	});

	it("does not write an already-aborted request and keeps the kernel usable", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-preabort-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const controller = new AbortController();
			controller.abort();
			const cancelled = await executeRubyWithKernel(kernel, 'File.write("aborted.txt", "nope")', {
				signal: controller.signal,
			});
			expect(cancelled.cancelled).toBe(true);

			const sideEffect = await executeRubyWithKernel(kernel, 'File.exist?("aborted.txt")', {});
			expect(sideEffect.exitCode).toBe(0);
			expect(sideEffect.output).toContain("false");

			const after = await executeRubyWithKernel(kernel, "20 + 22", {});
			expect(after.exitCode).toBe(0);
			expect(after.output).toContain("42");
		} finally {
			await kernel.shutdown();
		}
	});

	it("surfaces Ruby errors with a non-zero exit and the message", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-error-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executeRubyWithKernel(kernel, "raise 'boom'", {});
			expect(result.exitCode).toBe(1);
			expect(result.output).toContain("boom");
		} finally {
			await kernel.shutdown();
		}
	});

	it("surfaces Ruby and child-process stderr in output", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-stderr-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const result = await executeRubyWithKernel(
				kernel,
				[
					'$stderr.print("ruby stderr\\n")',
					'STDERR.print("constant stderr\\n")',
					'require "rbconfig"',
					'system(RbConfig.ruby, "-e", \'STDERR.print("child stderr\\\\n"); STDOUT.print("child stdout\\\\n")\')',
				].join("\n"),
				{},
			);
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain("ruby stderr\n");
			expect(result.output).toContain("constant stderr\n");
			expect(result.output).toContain("child stderr\n");
			expect(result.output).toContain("child stdout\n");
		} finally {
			await kernel.shutdown();
		}
	});

	it("exposes prelude file helpers", async () => {
		using tempDir = TempDir.createSync("@ruby-runner-prelude-");
		const kernel = await RubyKernel.start({ cwd: tempDir.path() });
		try {
			const written = await executeRubyWithKernel(kernel, 'write("note.txt", "hello"); read("note.txt")', {});
			expect(written.output).toContain("hello");
		} finally {
			await kernel.shutdown();
		}
	});
});
