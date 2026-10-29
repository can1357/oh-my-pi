import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	beginPendingDiskWrite,
	endPendingDiskWrite,
	reconcileOpenFilesFromDisk,
	refreshFile,
} from "@oh-my-pi/pi-coding-agent/lsp/client";
import type { LspClient } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";

/** Minimal client double: open files, a diagnostics map, and a frame sink. */
function fakeClient(openFiles: Map<string, { version: number; languageId: string }>): {
	client: LspClient;
	frames: string[];
} {
	const frames: string[] = [];
	const sink = {
		write(data: string | Uint8Array) {
			frames.push(typeof data === "string" ? data : new TextDecoder().decode(data));
			return data.length;
		},
		flush() {},
	};
	const client = {
		name: "fake",
		lastActivity: 0,
		writeQueue: Promise.resolve(),
		proc: { stdin: sink },
		openFiles: new Map(openFiles),
		diagnostics: new Map(),
	} as unknown as LspClient;
	return { client, frames };
}

describe("reconcileOpenFilesFromDisk", () => {
	test("re-syncs an open document whose disk text changed, then stays quiet once in sync", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reconcile-open-"));
		try {
			// The consumer was edited outside OMP: the server still holds the
			// pre-edit overlay, so a project-wide rename would compute ranges
			// against the old text (#15772).
			const consumer = path.join(dir, "b.ts");
			await fs.writeFile(consumer, "const respond = 1;\n");
			const uri = fileToUri(consumer);
			const { client, frames } = fakeClient(new Map([[uri, { version: 1, languageId: "typescript" }]]));

			expect(await reconcileOpenFilesFromDisk(client)).toBe(1);
			const didChange = frames.filter(frame => frame.includes("didChange"));
			expect(didChange.length).toBe(1);
			expect(didChange[0]).toContain("const respond = 1;");

			// In sync now: a second pass sends nothing.
			expect(await reconcileOpenFilesFromDisk(client)).toBe(0);
			expect(frames.filter(frame => frame.includes("didChange")).length).toBe(1);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("leaves documents that match disk untouched", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reconcile-open-"));
		try {
			const file = path.join(dir, "a.ts");
			await fs.writeFile(file, "export const x = 1;\n");
			const uri = fileToUri(file);
			const { client, frames } = fakeClient(new Map([[uri, { version: 1, languageId: "typescript" }]]));

			// First pass syncs it (the overlay's hash was unknown), the second
			// pass must be a no-op.
			await reconcileOpenFilesFromDisk(client);
			const before = frames.length;
			expect(await reconcileOpenFilesFromDisk(client)).toBe(0);
			expect(frames.length).toBe(before);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test("closes an open document deleted outside OMP", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-reconcile-open-"));
		try {
			const file = path.join(dir, "consumer.py");
			const uri = fileToUri(file);
			const { client, frames } = fakeClient(new Map([[uri, { version: 1, languageId: "python" }]]));

			expect(await reconcileOpenFilesFromDisk(client)).toBe(0);
			expect(frames.filter(frame => frame.includes("textDocument/didClose") && frame.includes(uri)).length).toBe(1);
			expect(client.openFiles.has(uri)).toBe(false);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});

describe("refreshFile", () => {
	test("keeps a missing document open while an OMP write to it is pending", async () => {
		// A new file's overlay is synced before the write commits it to disk, so
		// ENOENT here means "not written yet", not "deleted".
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-refresh-missing-"));
		const file = path.join(dir, "new.ts");
		const uri = fileToUri(file);
		const { client, frames } = fakeClient(new Map([[uri, { version: 1, languageId: "typescript" }]]));
		beginPendingDiskWrite(file);
		try {
			await refreshFile(client, file);
			expect(frames).toEqual([]);
			expect(client.openFiles.has(uri)).toBe(true);
		} finally {
			endPendingDiskWrite(file);
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
