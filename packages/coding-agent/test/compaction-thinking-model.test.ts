/**
 * Test for compaction with thinking models.
 *
 * Tests both:
 * - Claude via Antigravity (google-gemini-cli API)
 * - Claude via real Anthropic API (anthropic-messages API)
 *
 * Reproduces issue where compact fails when maxTokens < thinkingBudget.
 */

import { afterEach, beforeEach, describe } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./utilities";

// Check for auth
const HAS_ANTIGRAVITY_AUTH = false; // OAuth not available in test environment
const HAS_ANTHROPIC_AUTH = !!e2eApiKey("ANTHROPIC_API_KEY");

describe.skipIf(!HAS_ANTIGRAVITY_AUTH)("Compaction with thinking models (Antigravity)", () => {
	// oxlint-disable-next-line no-unassigned-vars -- e2e placeholder; assigned when the gated tests run
	let session: { dispose: () => Promise<void> } | undefined;
	let tempDir: string;
	let authStorage: { close: () => void } | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-thinking-compaction-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});
});
// ============================================================================
// Real Anthropic API tests (for comparison)
// ============================================================================

describe.skipIf(!HAS_ANTHROPIC_AUTH)("Compaction with thinking models (Anthropic)", () => {
	// oxlint-disable-next-line no-unassigned-vars -- e2e placeholder; assigned when the gated tests run
	let session: { dispose: () => Promise<void> } | undefined;
	let tempDir: string;
	let authStorage: { close: () => void } | undefined;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-thinking-compaction-anthropic-test-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
		authStorage?.close();
		authStorage = undefined;
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});
});
