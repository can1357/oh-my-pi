import { describe, expect, it } from "bun:test";
import { refuseToolShellAutoPrint } from "../../src/cli/tool-shell-launch";

describe("refuseToolShellAutoPrint", () => {
	const inToolShell = { OMPCODE: "1" };

	it("reports a pending invalid flag value before the refusal, so `--mode bogus` names the bad value", () => {
		const refusal = refuseToolShellAutoPrint({
			env: inToolShell,
			print: undefined,
			mode: undefined,
			stdinIsTerminal: false,
			invalidFlagValues: ['Invalid --mode value: "bogus". Expected one of: text, json, rpc, rpc-ui, acp.'],
		});
		expect(refusal?.startsWith('Error: Invalid --mode value: "bogus"')).toBe(true);
		expect(refusal).toContain("without a terminal");
	});

	it("refuses a headless launch from a tool shell that did not ask for -p, and says how to", () => {
		const refusal = refuseToolShellAutoPrint({
			env: inToolShell,
			print: undefined,
			mode: undefined,
			stdinIsTerminal: false,
		});
		expect(refusal).toContain("without a terminal");
		expect(refusal).toContain('-p "…"');
	});

	it("allows an explicit -p, a --mode, or a terminal from a tool shell", () => {
		expect(
			refuseToolShellAutoPrint({ env: inToolShell, print: true, mode: undefined, stdinIsTerminal: false }),
		).toBeUndefined();
		expect(
			refuseToolShellAutoPrint({ env: inToolShell, print: undefined, mode: "rpc", stdinIsTerminal: false }),
		).toBeUndefined();
		expect(
			refuseToolShellAutoPrint({ env: inToolShell, print: undefined, mode: undefined, stdinIsTerminal: true }),
		).toBeUndefined();
	});

	it("leaves a launch outside any tool shell alone, piped prompt included", () => {
		expect(
			refuseToolShellAutoPrint({ env: {}, print: undefined, mode: undefined, stdinIsTerminal: false }),
		).toBeUndefined();
		expect(
			refuseToolShellAutoPrint({ env: { OMPCODE: "0" }, print: undefined, mode: undefined, stdinIsTerminal: false }),
		).toBeUndefined();
	});
});
