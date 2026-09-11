#!/usr/bin/env bun
/** Test fixture: a stand-in worker that answers ONLY the operator queue verbs
 *  and echoes the command body back as the response data, so tests can assert
 *  what the worker actually received rather than what the client intended.
 *  Any other command gets success:false with the type it saw. */
process.stdout.write(`${JSON.stringify({ type: "ready" })}\n`);

for await (const raw of console) {
	if (!raw) continue;
	try {
		const frame = JSON.parse(raw) as Record<string, unknown>;
		if (typeof frame.type !== "string") continue;
		const id = typeof frame.id === "string" ? frame.id : undefined;
		const isQueueCommand = frame.type === "get_message_queue" || frame.type === "update_message_queue";
		const { id: _id, type, ...body } = frame;
		process.stdout.write(
			`${JSON.stringify(
				isQueueCommand
					? { id, type: "response", command: type, success: true, data: { sessionId: body.sessionId, commandSeen: type, ...body } }
					: { id, type: "response", command: type, success: false, error: `fixture only answers queue commands, saw ${type}` },
			)}\n`,
		);
	} catch {
		// malformed frame — test harness sends well-formed frames
	}
}
process.exit(0);
