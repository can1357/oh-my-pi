import { describe, expect, it } from "bun:test";
import { ScreenpipeClient } from "../src/client";

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
	return (async (input: string | URL, init?: RequestInit) => handler(String(input), init ?? {})) as typeof fetch;
}

function redactedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 5,
		timestamp: "2026-07-13T14:00:00.000Z",
		device_name: "device-1",
		app_name: "code",
		window_name: "main.rs",
		browser_url: null,
		focused: 1,
		snapshot_path: null,
		full_text_redacted_at: 1_752_415_200,
		accessibility_redacted_at: null,
		accessibility_tree_redacted_at: null,
		window_name_redacted_at: 1_752_415_200,
		browser_url_redacted_at: null,
		text_json_redacted_at: null,
		image_redacted_at: null,
		has_full_text: 1,
		has_accessibility_text: 0,
		has_accessibility_tree: 0,
		has_text_json: 0,
		...overrides,
	};
}

describe("ScreenpipeClient", () => {
	it("posts a bounded, redaction-gated SELECT to /raw_sql", async () => {
		let capturedUrl = "";
		let capturedQuery = "";
		const fetchImpl = fakeFetch((url, init) => {
			capturedUrl = url;
			capturedQuery = JSON.parse(String(init.body)).query;
			return new Response(JSON.stringify([]), { status: 200 });
		});
		const client = new ScreenpipeClient({ baseUrl: "http://127.0.0.1:3030/", fetchImpl });

		await client.fetchRedactedFrames({ sinceFrameId: 42, limit: 100 });

		expect(capturedUrl).toBe("http://127.0.0.1:3030/raw_sql");
		expect(capturedQuery).toContain("id > 42");
		expect(capturedQuery).toContain("LIMIT 100");
		expect(capturedQuery).toContain("image_redacted_at IS NOT NULL");
	});

	it("only references columns that exist in screenpipe's current frames schema", async () => {
		let capturedQuery = "";
		const fetchImpl = fakeFetch((_url, init) => {
			capturedQuery = JSON.parse(String(init.body)).query;
			return new Response(JSON.stringify([]), { status: 200 });
		});
		await new ScreenpipeClient({ fetchImpl }).fetchRedactedFrames({ sinceFrameId: 0, limit: 10 });

		// Dropped by screenpipe migration 20260507000000_drop_redaction_duplicate_columns.sql —
		// selecting either makes every poll fail with a 400.
		expect(capturedQuery).not.toContain("image_redaction_version");
		expect(capturedQuery).not.toContain("image_redaction_regions");
		// Perceptual fingerprint of PRE-redaction screen content; must never be read.
		expect(capturedQuery).not.toContain("content_hash");
	});

	it("parses a fully-redacted row", async () => {
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify([redactedRow()]), { status: 200 }));
		const client = new ScreenpipeClient({ fetchImpl });

		const frames = await client.fetchRedactedFrames({ sinceFrameId: 0, limit: 10 });

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ id: 5, app_name: "code" });
	});

	it("normalizes zoneless SQLite timestamps as UTC", async () => {
		const row = redactedRow({ timestamp: "2026-07-13 14:00:00" });
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify([row]), { status: 200 }));

		const frames = await new ScreenpipeClient({ fetchImpl }).fetchRedactedFrames({ sinceFrameId: 0, limit: 10 });

		expect(frames[0]?.timestamp).toBe("2026-07-13T14:00:00.000Z");
	});

	it('treats empty-string TEXT columns as absent (raw_sql serializes SQL NULL as "")', async () => {
		const row = redactedRow({ window_name: "", window_name_redacted_at: null, snapshot_path: "" });
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify([row]), { status: 200 }));

		const frames = await new ScreenpipeClient({ fetchImpl }).fetchRedactedFrames({ sinceFrameId: 0, limit: 10 });

		expect(frames).toHaveLength(1);
		expect(frames[0]).toMatchObject({ window_name: null, snapshot_path: null });
	});

	it("treats a zero watermark as never-redacted (raw_sql serializes SQL NULL integers as 0)", async () => {
		const row = redactedRow({ full_text_redacted_at: 0 });
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify([row]), { status: 200 }));

		const frames = await new ScreenpipeClient({ fetchImpl }).fetchRedactedFrames({ sinceFrameId: 0, limit: 10 });

		expect(frames).toEqual([]);
	});

	it("drops a row whose full_text is marked present but has no redaction watermark", async () => {
		const row = redactedRow({ full_text_redacted_at: null });
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify([row]), { status: 200 }));

		const frames = await new ScreenpipeClient({ fetchImpl }).fetchRedactedFrames({ sinceFrameId: 0, limit: 10 });

		expect(frames).toEqual([]);
	});

	it("drops a row with a snapshot but no image redaction watermark", async () => {
		const row = redactedRow({
			snapshot_path: "/home/user/.screenpipe/data/2026-07-13/1_m0.jpg",
			image_redacted_at: null,
		});
		const fetchImpl = fakeFetch(() => new Response(JSON.stringify([row]), { status: 200 }));

		const frames = await new ScreenpipeClient({ fetchImpl }).fetchRedactedFrames({ sinceFrameId: 0, limit: 10 });

		expect(frames).toEqual([]);
	});

	it("rejects a non-2xx response", async () => {
		const fetchImpl = fakeFetch(() => new Response("boom", { status: 500 }));
		const client = new ScreenpipeClient({ fetchImpl });

		await expect(client.fetchRedactedFrames({ sinceFrameId: 0, limit: 10 })).rejects.toThrow(
			"screenpipe /raw_sql returned 500",
		);
	});

	it("rejects an out-of-range limit", async () => {
		const client = new ScreenpipeClient({ fetchImpl: fakeFetch(() => new Response("[]")) });
		await expect(client.fetchRedactedFrames({ sinceFrameId: 0, limit: 0 })).rejects.toThrow(
			"limit must be a positive integer",
		);
		await expect(client.fetchRedactedFrames({ sinceFrameId: -1, limit: 10 })).rejects.toThrow(
			"sinceFrameId must be a non-negative integer",
		);
	});

	it("aborts a stalled request after the configured timeout", async () => {
		const fetchImpl = ((_input: string | URL, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
			})) as typeof fetch;
		const client = new ScreenpipeClient({ fetchImpl, requestTimeoutMs: 20 });

		await expect(client.fetchRedactedFrames({ sinceFrameId: 0, limit: 10 })).rejects.toThrow();
	});
});
