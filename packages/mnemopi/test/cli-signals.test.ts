import { describe, expect, it } from "bun:test";
import { lines, nextLine, spawnCli } from "./helpers/embed-ipc";

describe("mnemopi CLI entry", () => {
	// pi-utils defers its SIGINT/SIGTERM handlers to the CLI-owned process, and
	// embed-serve's shutdown contract depends on them: the postmortem pass releases
	// the endpoint and SIGKILLs before onnxruntime's crashing NAPI finalizer
	// (issue #3031). Without the install a signal ends the process by signal, so no
	// cleanup runs. Spawning the entry module is the only way to cover that.
	it("installs the handlers that turn SIGTERM into cleanup and exit 143", async () => {
		const child = spawnCli(["mcp"]);
		try {
			child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
			await child.stdin.flush();
			// The reply proves the entry point is up and its event loop is in the server.
			const reply = JSON.parse(await nextLine(lines(child.stdout)));
			expect(reply.result.serverInfo.name).toBe("mnemopi");

			child.kill("SIGTERM");

			expect(await child.exited).toBe(143);
			expect(child.signalCode).toBeNull();
		} finally {
			child.kill("SIGKILL");
		}
	}, 20_000);
});
