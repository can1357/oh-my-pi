import { describe, expect, it, spyOn } from "bun:test";
import {
	IndexedSessionStorage,
	type SessionStorageBackend,
	type SessionStorageIndexEntry,
} from "@oh-my-pi/pi-coding-agent/session/indexed-session-storage";
import { listSessions } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { readLatestSessionTitle } from "@oh-my-pi/pi-coding-agent/session/session-loader";
import { serializeTitleSlot, type SessionTitleUpdate } from "@oh-my-pi/pi-coding-agent/session/session-title-slot";

const timestamp = "2026-01-01T00:00:00.000Z";
const oldTitle = { title: "Stale slot", source: "auto", updatedAt: timestamp } as const;

function titleLine(title: string, source: "auto" | "user" = "user", updatedAt = timestamp): string {
	return `${JSON.stringify({ type: "title_change", id: title, parentId: "assistant", timestamp: updatedAt, title, source })}\n`;
}

function session(id: string, withSlot = true): string {
	return (
		(withSlot ? serializeTitleSlot(oldTitle) : "") +
		[
			{ type: "session", version: 3, id, cwd: "/indexed-cost", timestamp, title: "Stale header" },
			{
				type: "message",
				id: "user",
				parentId: null,
				timestamp,
				message: { role: "user", content: "Prompt", timestamp: 1 },
			},
			{
				type: "message",
				id: "assistant",
				parentId: "user",
				timestamp,
				message: { role: "assistant", content: [{ type: "text", text: "Reply" }], timestamp: 1 },
			},
			{
				type: "custom",
				id: "payload",
				parentId: "assistant",
				timestamp,
				customType: "large",
				data: "x".repeat(2 * 1024 * 1024),
			},
		]
			.map(entry => JSON.stringify(entry))
			.join("\n") +
		"\n" +
		titleLine(`Current ${id}`) +
		`${JSON.stringify({ type: "custom", id: "tail", parentId: "payload", timestamp, customType: "tail", data: "y".repeat(48 * 1024) })}\n`
	);
}

class Backend implements SessionStorageBackend {
	readonly files = new Map<string, string>();
	readonly metadata = new Map<string, SessionStorageIndexEntry & { titleIndexedSize?: number }>();
	fullReads = 0;
	sliceBytes = 0;
	appendCalls = 0;
	failAppend = false;
	appendGate: Promise<void> | undefined;
	async init() {}
	async loadIndex() {
		return [...this.metadata.values()].map(row => ({ ...row }));
	}
	async readFull(path: string) {
		this.fullReads++;
		return this.files.get(path) ?? null;
	}
	async readSlices(path: string, prefix: number, suffix: number): Promise<[string, string]> {
		this.sliceBytes += prefix + suffix;
		const bytes = Buffer.from(this.files.get(path) ?? "");
		return [bytes.subarray(0, prefix).toString(), suffix ? bytes.subarray(-suffix).toString() : ""];
	}
	async writeFull(path: string, content: string, mtimeMs: number, title?: SessionTitleUpdate) {
		this.files.set(path, content);
		const size = Buffer.byteLength(content);
		this.metadata.set(path, {
			path,
			size,
			mtimeMs,
			title: title?.title,
			titleSource: title?.source,
			titleUpdatedAt: title?.updatedAt,
			titleIndexedSize: size,
		});
	}
	async append(path: string, line: string, mtimeMs: number, title?: SessionTitleUpdate, titleIndexedSize?: number) {
		this.appendCalls++;
		await this.appendGate;
		if (this.failAppend) throw new Error("append rejected");
		const content = (this.files.get(path) ?? "") + line;
		this.files.set(path, content);
		const previous = this.metadata.get(path);
		this.metadata.set(path, {
			...previous,
			path,
			size: Buffer.byteLength(content),
			mtimeMs,
			...(titleIndexedSize === undefined
				? {}
				: { title: title?.title, titleSource: title?.source, titleUpdatedAt: title?.updatedAt, titleIndexedSize }),
		});
	}
	async updateSessionTitle(path: string, title: SessionTitleUpdate, mtimeMs: number) {
		const previous = this.metadata.get(path)!;
		this.metadata.set(path, {
			...previous,
			mtimeMs,
			title: title.title,
			titleSource: title.source,
			titleUpdatedAt: title.updatedAt,
			titleIndexedSize: undefined,
		});
	}
	async indexTitle(path: string, title: SessionTitleUpdate | undefined, size: number): Promise<void> {
		const previous = this.metadata.get(path)!;
		this.metadata.set(path, {
			...previous,
			title: title?.title,
			titleSource: title?.source,
			titleUpdatedAt: title?.updatedAt,
			titleIndexedSize: size,
		});
	}
	async truncate(path: string, mtimeMs: number) {
		await this.writeFull(path, "", mtimeMs);
	}
	async remove(paths: string[]) {
		for (const path of paths) {
			this.files.delete(path);
			this.metadata.delete(path);
		}
	}
	async move(src: string, dst: string, mtimeMs: number) {
		this.files.set(dst, this.files.get(src)!);
		this.metadata.set(dst, { ...this.metadata.get(src)!, path: dst, mtimeMs });
		await this.remove([src]);
	}
}

async function reopen(backend: Backend): Promise<IndexedSessionStorage> {
	const storage = new IndexedSessionStorage(backend);
	await storage.initialize();
	return storage;
}

describe("indexed journal title metadata", () => {
	it("lists reopened large sessions and live renames with bounded slices and zero full reads", async () => {
		const backend = new Backend();
		const first = await reopen(backend);
		const count = 4;
		for (let i = 0; i < count; i++) await first.writeText(`/indexed-cost/${i}.jsonl`, session(String(i)));
		const storage = await reopen(backend);
		const readText = spyOn(storage, "readText");
		try {
			const listed = await listSessions("/indexed-cost", storage);
			expect(listed.map(info => info.title).sort()).toEqual(Array.from({ length: count }, (_, i) => `Current ${i}`));
			for (let i = 0; i < count; i++) {
				expect(await readLatestSessionTitle(`/indexed-cost/${i}.jsonl`, storage)).toEqual({
					title: `Current ${i}`,
					source: "user",
					updatedAt: timestamp,
				});
			}
			const writer = storage.openWriter("/indexed-cost/0.jsonl");
			await writer.append(titleLine("Live rename", "auto", "2026-01-02T00:00:00.000Z"));
			await writer.close();
			expect((await listSessions("/indexed-cost", storage)).find(info => info.id === "0")?.title).toBe(
				"Live rename",
			);
			expect(await readLatestSessionTitle("/indexed-cost/0.jsonl", storage)).toEqual({
				title: "Live rename",
				source: "auto",
				updatedAt: "2026-01-02T00:00:00.000Z",
			});
			expect(readText).not.toHaveBeenCalled();
			expect(backend.fullReads).toBe(0);
			expect(backend.sliceBytes).toBeLessThanOrEqual((count + 1) * (4096 + 32768));
		} finally {
			readText.mockRestore();
		}
		const reopened = await reopen(backend);
		expect(await readLatestSessionTitle("/indexed-cost/0.jsonl", reopened)).toEqual({
			title: "Live rename",
			source: "auto",
			updatedAt: "2026-01-02T00:00:00.000Z",
		});
		expect(backend.fullReads).toBe(0);
	});

	for (const method of ["writeText", "writeTextSync", "writeTextAtomic"] as const) {
		it(`${method} seeds the last physical journal title without rewriting the stale slot`, async () => {
			const backend = new Backend();
			const storage = await reopen(backend);
			const content = session(method) + titleLine("Physically last", "auto", "2025-01-01T00:00:00.000Z");
			await storage[method]("/indexed-cost/full.jsonl", content);
			await storage.drain();
			expect(backend.metadata.get("/indexed-cost/full.jsonl")).toMatchObject({
				title: "Physically last",
				titleSource: "auto",
				titleUpdatedAt: "2025-01-01T00:00:00.000Z",
			});
			expect(await storage.readText("/indexed-cost/full.jsonl")).toBe(content);
			expect(backend.files.get("/indexed-cost/full.jsonl")).toBe(content);
		});
	}

	it("waits for pending title appends and rolls back every failed optimistic metadata frame", async () => {
		const backend = new Backend();
		const storage = await reopen(backend);
		const path = "/indexed-cost/rollback.jsonl";
		await storage.writeText(path, session("rollback"));
		const { promise, resolve: release } = Promise.withResolvers<void>();
		backend.appendGate = promise;
		backend.failAppend = true;
		const writer = storage.openWriter(path);
		const first = writer.append(titleLine("Rejected first")).catch(error => error);
		const second = writer.append(titleLine("Rejected second")).catch(error => error);
		let settled = false;
		const lookup = readLatestSessionTitle(path, storage).then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		expect(await first).toBeInstanceOf(Error);
		expect(await second).toBeInstanceOf(Error);
		await lookup;
		await expect(storage.drain()).rejects.toThrow("append rejected");
		expect(await readLatestSessionTitle(path, storage)).toEqual({
			title: "Current rollback",
			source: "user",
			updatedAt: timestamp,
		});
		expect(backend.metadata.get(path)?.title).toBe("Current rollback");
		expect(backend.appendCalls).toBe(1);
		await writer.close().catch(() => {});
	});

	it("reconciles unknown legacy metadata only on lookup, including titles outside both windows", async () => {
		const backend = new Backend();
		const path = "/indexed-cost/legacy.jsonl";
		const content = session("legacy");
		backend.files.set(path, content);
		backend.metadata.set(path, {
			path,
			size: Buffer.byteLength(content),
			mtimeMs: 1,
			title: oldTitle.title,
			titleSource: oldTitle.source,
			titleUpdatedAt: oldTitle.updatedAt,
		});
		const storage = await reopen(backend);
		expect(backend.fullReads).toBe(0);
		await storage.refresh();
		expect(backend.fullReads).toBe(0);
		expect(await readLatestSessionTitle(path, storage)).toEqual({
			title: "Current legacy",
			source: "user",
			updatedAt: timestamp,
		});
		expect(await readLatestSessionTitle(path, storage)).toEqual({
			title: "Current legacy",
			source: "user",
			updatedAt: timestamp,
		});
		expect(backend.fullReads).toBe(1);
		const reopened = await reopen(backend);
		expect(await readLatestSessionTitle(path, reopened)).toEqual({
			title: "Current legacy",
			source: "user",
			updatedAt: timestamp,
		});
		expect(backend.fullReads).toBe(1);
	});

	it("preserves known empty slots, legacy headers and missing-file lookup behavior", async () => {
		const backend = new Backend();
		const storage = await reopen(backend);
		const header = `${JSON.stringify({ type: "session", id: "header", timestamp, cwd: "/indexed-cost", title: "Header only" })}\n`;
		await storage.writeText("/indexed-cost/header.jsonl", header);
		await storage.writeText(
			"/indexed-cost/empty.jsonl",
			serializeTitleSlot({ title: "", updatedAt: timestamp }) + header,
		);
		expect(await readLatestSessionTitle("/indexed-cost/header.jsonl", storage)).toBeUndefined();
		expect(await readLatestSessionTitle("/indexed-cost/empty.jsonl", storage)).toEqual({
			title: "",
			source: undefined,
			updatedAt: timestamp,
		});
		await expect(readLatestSessionTitle("/indexed-cost/missing.jsonl", storage)).rejects.toMatchObject({
			code: "ENOENT",
		});
		expect(backend.fullReads).toBe(0);
	});

	it("preserves no-slot headers and overlays even a short valid-slot prefix", async () => {
		const backend = new Backend();
		const storage = await reopen(backend);
		const file = "/indexed-cost/no-slot.jsonl";
		const content = session("no-slot", false);
		await storage.writeText(file, content);
		expect((await storage.readTextSlices(file, 64, 0))[0]).toBe(Buffer.from(content).subarray(0, 64).toString());
		expect(await readLatestSessionTitle(file, storage)).toEqual({
			title: "Current no-slot",
			source: "user",
			updatedAt: timestamp,
		});
		const slotFile = "/indexed-cost/slot.jsonl";
		await storage.writeText(slotFile, serializeTitleSlot(oldTitle) + '{"type":"session","id":"slot"}\n');
		const updated = { title: "Changed slot", source: "user", updatedAt: timestamp } as const;
		await storage.updateSessionTitle(slotFile, updated);
		expect((await storage.readTextSlices(slotFile, 64, 0))[0]).toBe(
			Buffer.from(serializeTitleSlot(updated)).subarray(0, 64).toString(),
		);
		expect(backend.fullReads).toBe(0);
	});

	for (const consume of ["path", "all"] as const) {
		it(`does not let an old-path append failure poison a new-path drain before ${consume} consumption`, async () => {
			const backend = new Backend();
			const storage = await reopen(backend);
			const oldPath = "/indexed-cost/old.jsonl";
			const newPath = "/indexed-cost/new.jsonl";
			await storage.writeText(oldPath, '{"type":"session","id":"old"}\n');
			await storage.writeText(newPath, '{"type":"session","id":"new"}\n');
			const writer = storage.openWriter(oldPath);
			backend.failAppend = true;
			await expect(writer.append(titleLine("Failed old rename"))).rejects.toThrow("append rejected");
			await storage.drain(newPath);
			await expect(consume === "path" ? storage.drain(oldPath) : storage.drain()).rejects.toThrow("append rejected");
			await storage.drain(newPath);
			await storage.drain();
			await writer.close().catch(() => {});
		});
	}
	it("excludes retired-path failures without hiding an unrelated fire-and-forget failure", async () => {
		const backend = new Backend(),
			storage = await reopen(backend);
		const retired = "/indexed-cost/retired.jsonl",
			other = "/indexed-cost/other.jsonl";
		await storage.writeText(retired, '{"type":"session","id":"retired"}\n');
		await storage.writeText(other, '{"type":"session","id":"other"}\n');
		backend.failAppend = true;
		const oldWriter = storage.openWriter(retired),
			otherWriter = storage.openWriter(other);
		const oldError = await oldWriter.append(titleLine("Retired failure")).catch(error => error);
		const otherError = await otherWriter.append(titleLine("Unrelated failure")).catch(error => error);
		await expect(storage.drain(undefined, new Set([retired]))).rejects.toBe(otherError);
		await expect(storage.drain(retired)).rejects.toBe(oldError);
		await storage.drain();
		await oldWriter.close().catch(() => {});
		await otherWriter.close().catch(() => {});
	});

	it("does not wait for an obsolete path while globally draining non-retired writes", async () => {
		const backend = new Backend(),
			storage = await reopen(backend),
			retired = "/indexed-cost/retired-pending.jsonl";
		await storage.writeText(retired, '{"type":"session","id":"retired"}\n');
		const gate = Promise.withResolvers<void>();
		backend.appendGate = gate.promise;
		const writer = storage.openWriter(retired),
			append = writer.append(titleLine("Pending retired"));
		let settled = false;
		const draining = storage.drain(undefined, new Set([retired])).then(() => {
			settled = true;
		});
		for (let i = 0; i < 64; i++) await Promise.resolve();
		const settledBeforeRelease = settled;
		gate.resolve();
		await append;
		await draining;
		expect(settledBeforeRelease).toBe(true);
		await writer.close();
	});
});
