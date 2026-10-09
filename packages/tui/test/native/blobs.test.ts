import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { registerNativeBlob } from "@oh-my-pi/pi-tui/native/blobs";
import { node } from "@oh-my-pi/pi-tui/native/describe";
import type { NativeNode } from "@oh-my-pi/pi-tui/native/node";
import type { Component } from "@oh-my-pi/pi-tui/tui";
import { TspHarness } from "./tsp-harness";

describe("native image blob lifetime", () => {
	const cases = [
		...["base64", "image", "attachment", "snapcompact"].map(source => ({
			name: `releases discarded ${source} payloads after uploading them`,
			fixture: "blob-lifetime.ts",
			source,
		})),
		...[
			["reply", "delivers a settled image after a deferred missing-blob reply and releases its bytes"],
			["timeout", "delivers a settled image after an unanswered first query and releases its bytes"],
			["cache-timeout", "retains a settled image through a cache write and unanswered query"],
			["cache-held", "records a settled image held in the terminal cache before releasing its bytes"],
			["reset", "releases pending settled-image bytes when the connection resets"],
			["stop", "releases pending settled-image bytes when the backend stops"],
		].map(([source, name]) => ({ name, fixture: "pending-blob-delivery.ts", source })),
		{
			name: "releases evicted chart payloads while retaining cached and live native images",
			fixture: "table-chart-blob-lifetime.ts",
			source: "eviction",
		},
		{
			name: "releases replaced theme and cleared-cache chart payloads",
			fixture: "table-chart-blob-lifetime.ts",
			source: "theme",
		},
		{
			name: "keeps pending, shared, remounted, and replayed images available",
			fixture: "blob-replay.ts",
			source: "",
		},
		{
			name: "releases deleted attachment thumbnails while preserving undo and live chips",
			fixture: "attachment-blob-lifetime.ts",
			source: "",
		},
	];
	for (const { name, fixture, source } of cases) {
		it(
			name,
			async () => {
				await using root = await TempDir.create("@omp-native-blobs-");
				const env: NodeJS.ProcessEnv = {
					...process.env,
					PI_CONFIG_DIR: path.relative(os.homedir(), root.join("config")),
					PI_CODING_AGENT_DIR: root.join("agent"),
					PI_TEST_SESSION_OWNERS_DIR: root.join("session-owners"),
					XDG_CONFIG_HOME: root.join("xdg-config"),
					XDG_DATA_HOME: root.join("data"),
					XDG_STATE_HOME: root.join("state"),
					XDG_CACHE_HOME: root.join("cache"),
					PI_TUI_NATIVE: "1",
				};
				delete env.OMP_PROFILE;
				delete env.PI_PROFILE;
				await Promise.all(
					["config", "agent", "session-owners", "xdg-config", "data/omp", "state/omp", "cache/omp"].map(dir =>
						fs.promises.mkdir(root.join(dir), { recursive: true }),
					),
				);
				const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", fixture), source], {
					stdout: "pipe",
					stderr: "pipe",
					env,
				});
				const timeout = setTimeout(() => child.kill(), 10_000);
				try {
					const [stdout, stderr, exitCode] = await Promise.all([
						new Response(child.stdout).text(),
						new Response(child.stderr).text(),
						child.exited,
					]);
					expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: "", stdout: "verified\n" });
				} finally {
					clearTimeout(timeout);
					child.kill();
					await child.exited;
				}
			},
			15_000,
		);
	}
});

class Probe implements Component {
	current: NativeNode;
	constructor(current: NativeNode) {
		this.current = current;
	}
	render(): readonly string[] {
		return ["probe rows"];
	}
	describe(): NativeNode {
		return this.current;
	}
}

/** Fresh image bytes (the blob registry is process-wide) and an `image` node showing them. */
function image(): { id: string; bytes: Uint8Array; probe: () => Probe } {
	const bytes = crypto.getRandomValues(new Uint8Array(256));
	const id = registerNativeBlob(bytes, "image/png");
	return { id, bytes, probe: () => new Probe(node("image", { blob: id, alt: "pic" })) };
}

let harness: TspHarness | undefined;
let tempDir: string | undefined;
afterEach(() => {
	harness?.stop();
	harness = undefined;
	if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

const sent = (h: TspHarness, verb: string): unknown[] =>
	h.terminal.log.filter(message => message.verb === verb).map(message => message.body);

describe("native blob delivery", () => {
	it("uploads an image shown on two surfaces once", async () => {
		const pic = image();
		harness = await TspHarness.start(tui => tui.addChild(pic.probe()));
		const h = harness;
		const session = h.terminal.surface;
		const overlay = h.tui.showOverlay(pic.probe(), { width: "100%", fullscreen: true });
		await h.render();
		expect(h.terminal.surface).not.toBe(session);
		expect(h.find(n => n.k === "image")?.p).toMatchObject({ blob: pic.id });
		overlay.hide();
		h.flush();

		// Asked once on the fresh connection, then sent inline once for both surfaces.
		expect(sent(h, "q")).toEqual([{ q: "blobs", ids: [pic.id] }]);
		expect(sent(h, "b")).toEqual([Buffer.from(pic.bytes).toString("base64")]);
		expect(h.terminal.blobs.get(pic.id)).toEqual(pic.bytes);
		expect(h.errors).toEqual([]);
	});

	it("uploads inline without asking a terminal lacking the blobs feature", async () => {
		const pic = image();
		harness = await TspHarness.start(tui => tui.addChild(pic.probe()), { features: ["settle", "adopt", "dock"] });
		expect(sent(harness, "q")).toEqual([]);
		expect(sent(harness, "b")).toHaveLength(1);
		expect(harness.terminal.blobs.get(pic.id)).toEqual(pic.bytes);
	});

	it("reaches a Tern that still names blobs by their id parameter", async () => {
		const pic = image();
		harness = await TspHarness.start(tui => tui.addChild(pic.probe()), { requireBlobId: true });
		expect(sent(harness, "b")).toHaveLength(1);
		expect(harness.terminal.blobs.get(pic.id)).toEqual(pic.bytes);
	});

	it("doesn't upload a blob the terminal already holds", async () => {
		const pic = image();
		harness = await TspHarness.start(tui => tui.addChild(pic.probe()), { heldBlobs: [pic.bytes] });
		expect(sent(harness, "q")).toEqual([{ q: "blobs", ids: [pic.id] }]);
		expect(sent(harness, "b")).toEqual([]);
		expect(harness.find(n => n.k === "image")?.p).toMatchObject({ blob: pic.id });
	});

	it("records a blob the terminal already held with its full body, after the query", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tsp-record-"));
		const record = path.join(tempDir, "tsp.jsonl");
		const before = Bun.env.PI_TUI_TSP_RECORD;
		Bun.env.PI_TUI_TSP_RECORD = record;
		const pic = image();
		try {
			harness = await TspHarness.start(tui => tui.addChild(pic.probe()), { heldBlobs: [pic.bytes] });
		} finally {
			if (before === undefined) delete Bun.env.PI_TUI_TSP_RECORD;
			else Bun.env.PI_TUI_TSP_RECORD = before;
		}
		const lines = fs
			.readFileSync(record, "utf8")
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { dir: string; verb: string; params?: unknown; body: unknown })
			.filter(line => line.verb === "q" || line.verb === "b");
		expect(lines).toEqual([
			expect.objectContaining({ dir: "out", verb: "q", body: { q: "blobs", ids: [pic.id] } }),
			expect.objectContaining({
				dir: "out",
				verb: "b",
				params: { id: pic.id, mime: "image/png" },
				body: Buffer.from(pic.bytes).toString("base64"),
			}),
		]);
		expect(sent(harness, "b")).toEqual([]);
	});

	it("uploads blobs first seen after the connection's first pass inline, without asking", async () => {
		const first = image();
		const later = image();
		harness = await TspHarness.start(tui => tui.addChild(first.probe()));
		const h = harness;
		h.tui.addChild(later.probe());
		await h.render();
		expect(sent(h, "q")).toEqual([{ q: "blobs", ids: [first.id] }]);
		expect(sent(h, "b")).toHaveLength(2);
		expect(h.terminal.blobs.has(later.id)).toBe(true);
	});

	it("asks again after a stop/start cycle instead of resending what the terminal kept", async () => {
		const pic = image();
		harness = await TspHarness.start(tui => tui.addChild(pic.probe()));
		const h = harness;
		expect(sent(h, "b")).toHaveLength(1);
		h.tui.stop();
		h.flush();
		h.tui.start();
		h.flush();
		h.tui.addChild(pic.probe());
		await h.render();
		expect(sent(h, "q")).toEqual([
			{ q: "blobs", ids: [pic.id] },
			{ q: "blobs", ids: [pic.id] },
		]);
		expect(sent(h, "b")).toHaveLength(1);
		expect(h.findAll(n => n.k === "image")).toHaveLength(2);
	});

	it("hands a blob over through the terminal's blob cache under TERN_BLOB_DIR", async () => {
		const before = Bun.env.TERN_BLOB_DIR;
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tern-blobs-"));
		const pic = image();
		harness = await TspHarness.start(tui => tui.addChild(pic.probe()), { blobDir: tempDir });
		const h = harness;
		expect(Bun.env.TERN_BLOB_DIR).toBe(tempDir);
		await h.until(() => sent(h, "q").length > 0);
		h.flush();

		expect(fs.readFileSync(path.join(tempDir, pic.id)).equals(pic.bytes)).toBe(true);
		expect(fs.readdirSync(tempDir)).toEqual([pic.id]);
		expect(sent(h, "q")).toEqual([{ q: "blobs", ids: [pic.id] }]);
		expect(sent(h, "b")).toEqual([]);
		expect(h.terminal.blobs.get(pic.id)).toEqual(pic.bytes);
		expect(h.find(n => n.k === "image")?.p).toMatchObject({ blob: pic.id });

		h.stop();
		harness = undefined;
		expect(Bun.env.TERN_BLOB_DIR).toBe(before);
	});

	it("sends a blob inline when it couldn't be saved to the blob cache", async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "tern-blobs-"));
		const pic = image();
		const missing = path.join(tempDir, "absent");
		harness = await TspHarness.start(tui => tui.addChild(pic.probe()), { blobDir: missing });
		const h = harness;
		await h.until(() => sent(h, "b").length > 0);
		expect(sent(h, "q")).toEqual([{ q: "blobs", ids: [pic.id] }]);
		expect(fs.existsSync(missing)).toBe(false);
		expect(h.terminal.blobs.get(pic.id)).toEqual(pic.bytes);
	});

	it("falls back to inline upload when a blobs query goes unanswered", async () => {
		const pic = image();
		harness = await TspHarness.start(tui => tui.addChild(pic.probe()), { answerBlobs: false });
		const h = harness;
		expect(sent(h, "q")).toEqual([{ q: "blobs", ids: [pic.id] }]);
		// The frame went out without waiting for the blob.
		expect(h.find(n => n.k === "image")?.p).toMatchObject({ blob: pic.id });
		h.stall(2999);
		expect(sent(h, "b")).toEqual([]);
		h.stall(1);
		expect(sent(h, "b")).toHaveLength(1);
		expect(h.terminal.blobs.get(pic.id)).toEqual(pic.bytes);
	});
});
