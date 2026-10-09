import { afterEach, describe, expect, it, vi } from "bun:test";
import { logger } from "@oh-my-pi/pi-utils";
import { powerAssertionOptions } from "../src/session/agent-session";
import { resetPowerBackendUnavailableForTests, startPowerAssertion } from "../src/session/power-assertion-backend";

describe("powerAssertionOptions", () => {
	it("asks for no assertion when sleep prevention is off", () => {
		expect(powerAssertionOptions("off")).toBeUndefined();
	});

	it("selects cumulative flags per mode", () => {
		expect(powerAssertionOptions("idle")).toMatchObject({ idle: true, display: false, system: false, user: false });
		expect(powerAssertionOptions("display")).toMatchObject({ idle: true, display: true, system: false, user: false });
		expect(powerAssertionOptions("system")).toMatchObject({ idle: true, display: true, system: true, user: true });
	});
});

describe("startPowerAssertion", () => {
	const options = powerAssertionOptions("idle")!;
	const unavailable = () => {
		throw new Error(
			"PowerBackendUnavailable: Unable to connect to the system bus: I/O error: No such file or directory (os error 2)",
		);
	};

	afterEach(() => {
		vi.restoreAllMocks();
		resetPowerBackendUnavailableForTests();
	});

	it("does not warn when the system bus is unavailable, logs debug once, and stops retrying the backend", () => {
		resetPowerBackendUnavailableForTests();
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const start = vi.fn(unavailable);
		expect(startPowerAssertion(options, start)).toBeUndefined();
		expect(startPowerAssertion(options, start)).toBeUndefined();
		expect(start).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledTimes(0);
		expect(debug).toHaveBeenCalledTimes(1);
	});

	it("still warns when the system bus exists but refuses the connection", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const refused = () => {
			throw new Error("Unable to connect to the system bus: I/O error: Connection refused (os error 111)");
		};
		expect(startPowerAssertion(options, refused)).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(debug).toHaveBeenCalledTimes(0);
	});

	it("still warns on other failures", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const debug = vi.spyOn(logger, "debug").mockImplementation(() => {});
		const failing = () => {
			throw new Error("login1 Inhibit failed: access denied");
		};
		expect(startPowerAssertion(options, failing)).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(debug).toHaveBeenCalledTimes(0);
	});
});
