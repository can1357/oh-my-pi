import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import { removeWithRetries } from "../../utils/src/temp";

describe("AuthStorage credential store epoch identity", () => {
	let tempDir = "";

	test("epoch is stable across reopen and unique per backing store", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-store-epoch-"));
		try {
			const dbPath = path.join(tempDir, "agent.db");
			// Reopening the same backing store must keep the epoch: persisted
			// pins (delayed usage-limit attribution) stay valid across restarts.
			const first = await AuthStorage.create(dbPath);
			const epoch = first.credentialStoreEpoch;
			first.close();
			const reopened = await AuthStorage.create(dbPath);
			try {
				expect(reopened.credentialStoreEpoch).toBe(epoch);
			} finally {
				reopened.close();
			}
			// A different backing store mints a different base, so an
			// independent store can never validate its row ids here.
			const other = await AuthStorage.create(path.join(tempDir, "other.db"));
			try {
				expect(other.credentialStoreEpoch).not.toBe(epoch);
			} finally {
				other.close();
			}
		} finally {
			if (tempDir) {
				await removeWithRetries(tempDir);
				tempDir = "";
			}
		}
	});
});
