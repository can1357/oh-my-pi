import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ensureGraphCommonJsRequireRegistered } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/legacy-pi-compat";

// The global key the host bundle and every re-instantiated shim copy share to
// hand graph-owned CommonJS modules to whichever instance owns the populated
// graph state.
const COMMONJS_REQUIRE_GLOBAL = "__ompLegacyPiRequireGraphModule";

describe("issue #6449: legacy pi CommonJS graph registration is first-wins", () => {
	let original: unknown;

	beforeEach(() => {
		original = Reflect.get(globalThis, COMMONJS_REQUIRE_GLOBAL);
	});

	afterEach(() => {
		Reflect.set(globalThis, COMMONJS_REQUIRE_GLOBAL, original);
	});

	// On source-link installs the pi-coding-agent root shim is served from src/,
	// so an extension import evaluates a SECOND instance of legacy-pi-compat with
	// empty graph state. Its module-level registration must not clobber the host
	// bundle's populated bridge — a regression to an unconditional `Reflect.set`
	// broke transitive CommonJS resolution ("Missing graph-owned CommonJS
	// definition"). `ensureGraphCommonJsRequireRegistered` is exactly the
	// module-level registration a second instance runs.
	it("does not overwrite an existing bridge registration", () => {
		const hostBridge = (path: string): unknown => `host:${path}`;
		Reflect.set(globalThis, COMMONJS_REQUIRE_GLOBAL, hostBridge);

		// Re-running the registration (as a second instance would) is a no-op.
		ensureGraphCommonJsRequireRegistered();

		expect(Reflect.get(globalThis, COMMONJS_REQUIRE_GLOBAL)).toBe(hostBridge);
	});

	it("registers a bridge when none is present yet", () => {
		Reflect.deleteProperty(globalThis, COMMONJS_REQUIRE_GLOBAL);

		ensureGraphCommonJsRequireRegistered();

		expect(typeof Reflect.get(globalThis, COMMONJS_REQUIRE_GLOBAL)).toBe("function");
	});
});
