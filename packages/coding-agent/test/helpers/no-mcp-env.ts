import { onTestFinished } from "bun:test";

/** Set `PI_NO_MCP` for the running test only; `undefined` removes it. */
export function setNoMcpEnvForTest(value: string | undefined): void {
	const previous = process.env.PI_NO_MCP;
	if (value === undefined) delete process.env.PI_NO_MCP;
	else process.env.PI_NO_MCP = value;
	onTestFinished(() => {
		if (previous === undefined) delete process.env.PI_NO_MCP;
		else process.env.PI_NO_MCP = previous;
	});
}
