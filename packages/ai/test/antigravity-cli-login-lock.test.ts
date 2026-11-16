import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { withAgyLoginLock } from "../src/registry/oauth/antigravity-cli";

describe("Antigravity CLI login lock", () => {
	it("rejects a concurrent sign-in until the holder releases the lock", async () => {
		using temp = TempDir.createSync("@omp-agy-login-lock-");
		const root = temp.join("logins");
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const first = withAgyLoginLock(root, async () => {
			held.resolve();
			await release.promise;
			return "first";
		});
		await held.promise;
		try {
			await expect(withAgyLoginLock(root, async () => "second")).rejects.toThrow("already signing in");
		} finally {
			release.resolve();
		}
		expect(await first).toBe("first");
		expect(await withAgyLoginLock(root, async () => "third")).toBe("third");
	});
});
