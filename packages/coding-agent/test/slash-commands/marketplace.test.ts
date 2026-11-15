import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CATALOG_ERROR = "Marketplace catalog not found at /gone/marketplace.json. Try: /marketplace update mymkt";

describe("/marketplace interactive selector failures", () => {
	let root: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-marketplace-slash-"));
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	// A selector that fails to load (e.g. a deleted marketplace catalog) must surface as a status
	// line; an unhandled rejection here exits the interactive session.
	for (const input of ["/marketplace", "/marketplace install", "/marketplace uninstall"]) {
		test(`${input} reports a failing selector as a status`, async () => {
			const statuses: string[] = [];
			const ctx = {
				sessionManager: { getCwd: () => root },
				showPluginSelector: () => Promise.reject(new Error(CATALOG_ERROR)),
				showStatus: (message: string) => statuses.push(message),
				editor: { setText: () => {} },
			} as never as InteractiveModeContext;

			await executeBuiltinSlashCommand(input, { ctx });

			expect(statuses).toEqual([`Marketplace error: ${CATALOG_ERROR}`]);
		});
	}
});
