/**
 * Best-effort notification sinks for DurableRunner.
 *
 * Webhook URLs are supplied by the runner/CLI at startup and MUST never be
 * persisted into job or event payloads.
 */

import * as dns from "node:dns/promises";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { NotificationSink } from "./runner";
import type { NotificationRecord } from "./types";

const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

export interface FileNotificationSinkOptions {
	readonly filePath: string;
}

export interface WebhookNotificationSinkOptions {
	readonly url: string;
	readonly timeoutMs?: number;
	readonly fetchImpl?: typeof fetch;
	readonly allowPrivateHosts?: boolean;
}

export function createFileNotificationSink(options: FileNotificationSinkOptions): NotificationSink {
	const filePath = path.resolve(options.filePath.trim());
	if (!filePath) {
		throw new Error("notify file path is required");
	}

	return {
		async notify(notification: NotificationRecord): Promise<void> {
			await fs.mkdir(path.dirname(filePath), { recursive: true });
			const line = `${JSON.stringify(notification)}\n`;
			await fs.appendFile(filePath, line, "utf8");
		},
	};
}

export function assertHttpOrHttpsUrl(raw: string): URL {
	const trimmed = raw.trim();
	if (!trimmed) {
		throw new Error("webhook URL is required");
	}
	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		throw new Error(`invalid webhook URL: ${trimmed}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`webhook URL must be http or https (got ${parsed.protocol})`);
	}
	return parsed;
}

function isPrivateIp(address: string): boolean {
	if (net.isIPv4(address)) {
		const parts = address.split(".").map(Number);
		const [a = 0, b = 0] = parts;
		return (
			a === 0 ||
			a === 10 ||
			a === 127 ||
			(a === 100 && b >= 64 && b <= 127) ||
			(a === 169 && b === 254) ||
			(a === 172 && b >= 16 && b <= 31) ||
			(a === 192 && b === 168) ||
			(a === 198 && (b === 18 || b === 19)) ||
			a >= 224
		);
	}
	if (net.isIPv6(address)) {
		const normalized = address.toLowerCase();
		return (
			normalized === "::" ||
			normalized === "::1" ||
			normalized.startsWith("fc") ||
			normalized.startsWith("fd") ||
			/^fe[89ab]/.test(normalized) ||
			normalized.startsWith("ff") ||
			normalized.startsWith("::ffff:127.") ||
			normalized.startsWith("::ffff:10.") ||
			normalized.startsWith("::ffff:192.168.")
		);
	}
	return true;
}

async function assertPublicWebhookTarget(url: URL, allowPrivateHosts: boolean): Promise<void> {
	if (allowPrivateHosts) return;
	const hostname = url.hostname.toLowerCase();
	if (hostname === "localhost" || hostname.endsWith(".localhost")) {
		throw new Error("webhook target must not resolve to a private address");
	}
	const literalKind = net.isIP(hostname);
	if (literalKind !== 0) {
		if (isPrivateIp(hostname)) throw new Error("webhook target must not resolve to a private address");
		return;
	}
	const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
	if (addresses.length === 0 || addresses.some(entry => isPrivateIp(entry.address))) {
		throw new Error("webhook target must not resolve to a private address");
	}
}

export function createWebhookNotificationSink(options: WebhookNotificationSinkOptions): NotificationSink {
	const initialUrl = assertHttpOrHttpsUrl(options.url);
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_WEBHOOK_TIMEOUT_MS);
	const fetchImpl = options.fetchImpl ?? fetch;
	const allowPrivateHosts = options.allowPrivateHosts === true;

	return {
		async notify(notification: NotificationRecord): Promise<void> {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				let currentUrl = initialUrl;
				for (let redirects = 0; redirects <= 5; redirects++) {
					await assertPublicWebhookTarget(currentUrl, allowPrivateHosts);
					const response = await fetchImpl(currentUrl, {
						method: "POST",
						headers: {
							"content-type": "application/json",
							accept: "application/json",
							"idempotency-key": notification.id,
						},
						body: JSON.stringify(notification),
						signal: controller.signal,
						redirect: "manual",
					});
					if (response.status >= 300 && response.status < 400) {
						const location = response.headers.get("location");
						if (!location || redirects === 5) throw new Error("webhook redirect limit exceeded");
						currentUrl = assertHttpOrHttpsUrl(new URL(location, currentUrl).toString());
						continue;
					}
					if (!response.ok) throw new Error(`webhook POST failed with HTTP ${response.status}`);
					return;
				}
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

export function composeNotificationSinks(sinks: readonly NotificationSink[]): NotificationSink | undefined {
	const active = sinks.filter(Boolean);
	if (active.length === 0) return undefined;
	if (active.length === 1) return active[0];
	return {
		async notify(notification: NotificationRecord): Promise<void> {
			const errors: string[] = [];
			for (const sink of active) {
				try {
					await sink.notify(notification);
				} catch (error) {
					errors.push(error instanceof Error ? error.message : String(error));
				}
			}
			if (errors.length > 0) {
				throw new Error(`notification sink failures: ${errors.join("; ")}`);
			}
		},
	};
}
