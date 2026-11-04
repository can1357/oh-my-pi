import { parentPort } from "node:worker_threads";
import { logger } from "@oh-my-pi/pi-utils";

// Logged while the worker's entry module graph evaluates, before main's init arrives.
logger.info("early-log: during evaluation", { phase: "evaluation" });

// Runs after the entry's own listener handled the init message (the link exists by then).
parentPort?.once("message", () => {
	logger.info("early-log: after init", { phase: "init" });
});
