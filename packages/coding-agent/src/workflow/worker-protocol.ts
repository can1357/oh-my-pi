/**
 * Wire contract between `runWorkflowScript` (vm.ts) and its Bun Worker
 * (worker.ts). Both sides import these types only. The worker is loaded by the
 * CLI worker host or, outside the CLI, directly by URL.
 */

/** Messages the host posts to the workflow worker. */
export type WorkflowHostMessage =
	| { type: "init"; prelude: string; harden: string; envelopeSource: string; args: string; heartbeatMs: number }
	| { type: "agentResult"; requestId: number; result: string }
	| { type: "agentError"; requestId: number; error: string };

/** Messages the workflow worker posts to the host. */
export type WorkflowWorkerMessage =
	| { type: "agent"; requestId: number; callPath: string; payload: string }
	| { type: "log"; line: string }
	| { type: "phase"; name: string }
	| { type: "parallelFailure" }
	| { type: "heartbeat" }
	| { type: "done"; envelopeJson: string }
	| { type: "error"; message: string };
