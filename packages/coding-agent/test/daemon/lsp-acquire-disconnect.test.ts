/**
 * An `lsp` acquire whose client disconnects while the acquire is still resolving its cwd
 * reserves nothing: the instance key stays free for the next client.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import type { ModuleClient, ModuleContext } from "../../src/daemon/module";
import { lspModule } from "../../src/daemon/modules/lsp";
import { LSP_ACQUIRE_METHOD, type LspAcquireResult, lspInstanceKey, muxServerKey } from "../../src/lsp/mux/protocol";

const SERVER = { command: "fake-language-server", args: [], cwd: os.tmpdir() };

/** No units yet: every instance key is free unless reserved. */
const context = { unit: () => undefined } as unknown as ModuleContext;

function client(): ModuleClient {
	return { connectionId: crypto.randomUUID(), pid: 0, build: "" };
}

function acquire(from: ModuleClient): Promise<LspAcquireResult> {
	return lspModule.call!(context, LSP_ACQUIRE_METHOD, SERVER, from, undefined) as Promise<LspAcquireResult>;
}

afterEach(async () => {
	await lspModule.dispose?.();
});

describe("lsp acquire after its client disconnected", () => {
	it("reserves nothing for a client that disconnected while its acquire resolved the cwd", async () => {
		const gone = client();
		const abandoned = acquire(gone);
		lspModule.disconnected!(gone);
		await expect(abandoned).rejects.toThrow();

		// The first instance is free for the next client, not held by an abandoned reservation.
		const next = await acquire(client());
		expect(next.key).toBe(lspInstanceKey(muxServerKey(SERVER), 0));
	});
});
