import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import {
	assertHttpOrHttpsUrl,
	createFileNotificationSink,
	createWebhookNotificationSink,
} from "../../src/operational/notification-sinks";
import type { NotificationRecord } from "../../src/operational/types";

function sampleNotification(id = "n1"): NotificationRecord {
	return {
		id,
		kind: "job_completed",
		title: "done",
		body: "ok",
		read: false,
		metadata: { jobId: "j1" },
		createdAt: Date.now(),
	};
}

describe("notification sinks", () => {
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

	it("appends JSONL records to a file sink", async () => {
		tempDir = await TempDir.create("@notify-file-");
		const filePath = path.join(tempDir.path(), "out", "notify.jsonl");
		const sink = createFileNotificationSink({ filePath });
		await sink.notify(sampleNotification("a"));
		await sink.notify(sampleNotification("b"));
		const text = await Bun.file(filePath).text();
		const lines = text
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as NotificationRecord);
		expect(lines.map(l => l.id)).toEqual(["a", "b"]);
	});

	it("validates webhook URLs and POSTs JSON with timeout", async () => {
		expect(() => assertHttpOrHttpsUrl("ftp://x")).toThrow(/http or https/);
		expect(() => assertHttpOrHttpsUrl("not a url")).toThrow(/invalid webhook URL/);

		const calls: Array<{ url: string; init: RequestInit }> = [];
		const sink = createWebhookNotificationSink({
			url: "https://example.test/hook",
			timeoutMs: 100,
			allowPrivateHosts: true,
			fetchImpl: (async (...args: Parameters<typeof fetch>) => {
				const [input, init] = args;
				calls.push({ url: String(input), init: (init ?? {}) as RequestInit });
				return new Response("ok", { status: 200 });
			}) as unknown as typeof fetch,
		});
		await sink.notify(sampleNotification());
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://example.test/hook");
		expect(calls[0]?.init.method).toBe("POST");
		expect(
			String(calls[0]?.init.headers && (calls[0]!.init.headers as Record<string, string>)["content-type"]),
		).toContain("application/json");
	});

	it("fails webhook sink on non-OK responses", async () => {
		const sink = createWebhookNotificationSink({
			url: "http://127.0.0.1/hook",
			allowPrivateHosts: true,
			fetchImpl: (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch,
		});
		await expect(sink.notify(sampleNotification())).rejects.toThrow(/HTTP 500/);
	});

	it("rejects private webhook targets by default", async () => {
		const sink = createWebhookNotificationSink({
			url: "http://127.0.0.1/hook",
			fetchImpl: (async () => new Response("ok")) as unknown as typeof fetch,
		});
		await expect(sink.notify(sampleNotification())).rejects.toThrow(/private address/);
	});

	it("aborts a webhook request at the configured timeout", async () => {
		const sink = createWebhookNotificationSink({
			url: "https://example.test/hook",
			timeoutMs: 5,
			allowPrivateHosts: true,
			fetchImpl: (async (...args: Parameters<typeof fetch>) => {
				const signal = args[1]?.signal;
				const aborted = Promise.withResolvers<Response>();
				signal?.addEventListener("abort", () => aborted.reject(new DOMException("aborted", "AbortError")), {
					once: true,
				});
				return aborted.promise;
			}) as unknown as typeof fetch,
		});
		await expect(sink.notify(sampleNotification())).rejects.toThrow();
	});
});
