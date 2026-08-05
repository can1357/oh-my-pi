import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveSharedGopkClipsCapturePolicy, sharedConfigPath } from "./paths";

const originalLocalAppData = process.env.LOCALAPPDATA;
let root = "";

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "gopk-shared-policy-"));
	process.env.LOCALAPPDATA = root;
});

afterEach(async () => {
	if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
	else process.env.LOCALAPPDATA = originalLocalAppData;
	await fs.rm(root, { recursive: true, force: true });
});

async function persistConfig(value: unknown): Promise<void> {
	await fs.mkdir(path.dirname(sharedConfigPath()), { recursive: true });
	await fs.writeFile(sharedConfigPath(), JSON.stringify(value), "utf8");
}

describe("shared gopk capture policy", () => {
	it("fails closed when config or current consent is missing", async () => {
		expect(resolveSharedGopkClipsCapturePolicy()).toEqual({ enabled: false, ocrEnabled: false });
		await persistConfig({
			enabled: true,
			ocrEnabled: true,
			consent: {
				acceptedAt: "2026-07-29T00:00:00.000Z",
				policyVersion: "context-retention/v1",
				framesOptIn: true,
				ocrOptIn: true,
			},
		});
		expect(resolveSharedGopkClipsCapturePolicy()).toEqual({ enabled: false, ocrEnabled: false });
	});

	it("enables OCR only when capture, frames, current consent, and OCR opt-in all agree", async () => {
		const consent = {
			acceptedAt: "2026-07-29T00:00:00.000Z",
			policyVersion: "context-retention/v2",
			framesOptIn: true,
			ocrOptIn: true,
		};
		await persistConfig({ enabled: true, ocrEnabled: true, consent });
		expect(resolveSharedGopkClipsCapturePolicy()).toEqual({ enabled: true, ocrEnabled: true });
		await persistConfig({ enabled: true, ocrEnabled: false, consent: { ...consent, ocrOptIn: false } });
		expect(resolveSharedGopkClipsCapturePolicy()).toEqual({ enabled: true, ocrEnabled: false });
	});
});
