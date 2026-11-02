/**
 * MCP policy seams for tests.
 *
 * The test runner (`scripts/ci-test-ts.ts`) exports `PI_NO_MCP=1` so no test
 * starts the developer's MCP servers, and omp then refuses every MCP server
 * start. A test that starts stub servers it owns opts back in with
 * {@link allowMCPInTests}; a test of the disabled state sets it with
 * {@link setNoMcpEnvForTest}, so it holds with or without the runner.
 */
import { afterEach, beforeEach, vi } from "bun:test";
import * as mcpPolicy from "@oh-my-pi/pi-coding-agent/mcp/policy";
import { setNoMcpEnvForTest } from "./no-mcp-env";
/**
 * Let every test in the enclosing scope (file or `describe`) start MCP
 * servers, whatever `PI_NO_MCP` says. Spawned omp processes are not covered:
 * give them `PI_NO_MCP: ""` in their environment instead.
 */
export function allowMCPInTests(): void {
	let restore: (() => void) | undefined;
	beforeEach(() => {
		const spy = vi.spyOn(mcpPolicy, "isMCPDisabled").mockReturnValue(false);
		restore = () => spy.mockRestore();
	});
	afterEach(() => {
		restore?.();
		restore = undefined;
	});
}

export { setNoMcpEnvForTest };
