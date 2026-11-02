import { beforeEach, onTestFinished, spyOn } from "bun:test";
import * as mcpTimeout from "@oh-my-pi/pi-coding-agent/mcp/timeout";

/**
 * Give MCP requests and connections their configured deadline only when a test
 * sends them through the returned `underDeadline`; everything else (a fresh
 * fixture's first answer, barrier requests) runs without one. A freshly started
 * Bun fixture can take longer than a 100–300 ms deadline to answer on a loaded
 * host, which made those tests fail while the code under test was correct.
 *
 * `StdioTransport.request` and `connectToServer` read the deadline
 * synchronously when they start, so it applies to exactly the call `send`
 * makes. This also keeps deadlines hermetic: `OMP_MCP_TIMEOUT_MS` is ignored.
 */
export function deadlinesOnlyUnderDeadline(): <T>(send: () => T) => T {
	let armed = false;
	beforeEach(() => {
		const spy = spyOn(mcpTimeout, "resolveMCPTimeoutMs").mockImplementation(timeout => (armed ? (timeout ?? 0) : 0));
		onTestFinished(() => spy.mockRestore());
	});
	return send => {
		armed = true;
		try {
			return send();
		} finally {
			armed = false;
		}
	};
}
