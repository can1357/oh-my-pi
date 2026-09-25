import type { GalleryFixture } from "./types";

const service = {
	name: "web",
	id: "web",
	state: "ready",
	pid: 4123,
	createdAt: Date.now() - 10_000,
	startedAt: Date.now() - 9_000,
	readyAt: Date.now() - 8_000,
	restartCount: 0,
	outputBytes: 64,
	persist: true,
	detached: false,
};
const job = { id: "build-42", type: "bash", status: "cancelled", label: "Build assets", durationMs: 2000 };
const failure = (text: string) => ({ content: [{ type: "text", text }], isError: true });

export const coordinationFixtures: Record<string, GalleryFixture> = {
	write_agent: {
		label: "Peer message",
		renderer: "write",
		streamingArgs: { path: "agent://Reviewer", content: "Please review" },
		args: { path: "agent://Reviewer", content: "Please review the parser.\nCheck the error boundary." },
		result: {
			content: [{ type: "text", text: "Delivered to Reviewer." }],
			details: { message: { op: "send", to: "Reviewer", receipts: [{ to: "Reviewer", outcome: "injected" }] } },
		},
		errorResult: failure("Peer messaging is unavailable in this session."),
	},
	write_agent_broadcast: {
		label: "Peer broadcast",
		renderer: "write",
		streamingArgs: { path: "agent://all", content: "Heads up" },
		args: { path: "agent://all", content: "Heads up: tests are ready." },
		result: {
			content: [{ type: "text", text: "Broadcast delivered to 2 of 3 peer(s)." }],
			details: {
				message: {
					op: "send",
					to: "all",
					receipts: [
						{ to: "A", outcome: "injected" },
						{ to: "B", outcome: "revived" },
						{ to: "C", outcome: "failed", error: "not running" },
					],
				},
			},
		},
		errorResult: failure("No recipient accepted this broadcast."),
	},
	write_agent_failed_receipt: {
		label: "Undelivered message",
		renderer: "write",
		streamingArgs: { path: "agent://Missing", content: "Can you help?" },
		args: { path: "agent://Missing", content: "Can you help?" },
		result: {
			content: [{ type: "text", text: "Failed: Missing is not running." }],
			details: {
				message: {
					op: "send",
					to: "Missing",
					receipts: [{ to: "Missing", outcome: "failed", error: "not running" }],
				},
			},
		},
		errorResult: failure("Peer messaging is unavailable in this session."),
	},
	write_proc_cancel: {
		label: "Cancel job",
		renderer: "write",
		streamingArgs: { path: "proc://build-42/kill" },
		args: { path: "proc://build-42/kill" },
		result: {
			content: [{ type: "text", text: "Cancelled background job build-42." }],
			details: { proc: { op: "cancel", jobs: [job], cancelled: [{ id: "build-42", status: "cancelled" }] } },
		},
		errorResult: failure("Background job or service not found: build-42"),
	},
	write_proc_stdin: {
		label: "Service input",
		renderer: "write",
		streamingArgs: { path: "proc://web", content: "reload" },
		args: { path: "proc://web", content: "reload\n" },
		result: {
			content: [{ type: "text", text: "Sent input to web" }],
			details: { proc: { action: "stdin", daemon: service, input: "reload\n" } },
		},
		errorResult: failure("Cannot send input to exited service web"),
	},
	write_proc_stop: {
		label: "Stop service",
		renderer: "write",
		streamingArgs: { path: "proc://web/kill" },
		args: { path: "proc://web/kill" },
		result: {
			content: [{ type: "text", text: "Stopped web" }],
			details: { proc: { action: "stop", daemon: { ...service, state: "exited", exitedAt: Date.now() } } },
		},
		errorResult: failure("Service not found: web"),
	},
	write_proc_mode: {
		label: "Service mode",
		renderer: "write",
		streamingArgs: { path: "proc://web/mode", content: "persist" },
		args: { path: "proc://web/mode", content: "persist" },
		result: {
			content: [{ type: "text", text: "web; mode=persist" }],
			details: { proc: { action: "mode", daemon: service, mode: "persist" } },
		},
		errorResult: failure("Service mode must be persist, session, or detached"),
	},
	read_proc_list: {
		label: "Background activity",
		renderer: "read",
		streamingArgs: { path: "proc://" },
		args: { path: "proc://" },
		result: {
			content: [{ type: "text", text: "build-42 [bash] cancelled\nweb [service] ready" }],
			details: { proc: { jobs: [job], daemons: [service] } },
		},
		errorResult: failure("proc:// requires a tool session"),
	},
	read_proc_job: {
		label: "Job status",
		renderer: "read",
		streamingArgs: { path: "proc://build-42" },
		args: { path: "proc://build-42" },
		result: {
			content: [{ type: "text", text: "build-42 [bash] — cancelled" }],
			details: { proc: { job: { ...job, resultText: "Build cancelled by user." } } },
		},
		errorResult: failure("Background job or service not found: build-42"),
	},
	read_proc_service: {
		label: "Service logs",
		renderer: "read",
		streamingArgs: { path: "proc://web" },
		args: { path: "proc://web" },
		result: {
			content: [{ type: "text", text: "web [service] ready\nListening on 5173" }],
			details: { proc: { daemon: service, log: "Starting server\nListening on 5173" } },
		},
		errorResult: failure("Service not found: web"),
	},
};
