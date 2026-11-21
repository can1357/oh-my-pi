import "../../src/thread/subagent-worker-entry";
import { logger } from "@oh-my-pi/pi-utils";

// A non-local target: only a PI_PROXY-wrapped global fetch sends this to the test's proxy.
fetch("http://proxied.invalid/probe").then(
	async response => logger.debug("proxy-probe: done", { status: response.status, body: await response.text() }),
	(error: unknown) => logger.debug("proxy-probe: failed", { error: String(error) }),
);
