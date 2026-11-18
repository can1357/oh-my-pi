/**
 * Fake infer worker for `test/daemon/infer-module.test.ts`: speaks the
 * LF-delimited JSON stdio protocol the daemon `infer` module routes.
 *
 * - `ping` -> `pong`
 * - `echo { text, delayMs? }` -> `text { text }` after `delayMs`
 * - `steps { count }` -> `count` x `progress { step }`, then `text { text: "done" }`
 * - `env { name }` -> `text { value }` with the variable as this process sees it (null when unset)
 * - `pid` -> `text { pid }`
 * - `hang` -> one `progress`, never a terminal reply
 *
 * Exits when stdin closes.
 */
interface Request {
	type: string;
	id: string;
	text?: string;
	delayMs?: number;
	count?: number;
	name?: string;
}

function send(message: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function handle(request: Request): void {
	const { id } = request;
	switch (request.type) {
		case "ping":
			send({ type: "pong", id });
			return;
		case "echo":
			setTimeout(() => send({ type: "text", id, text: request.text }), request.delayMs ?? 0);
			return;
		case "steps":
			for (let step = 0; step < (request.count ?? 0); step++) send({ type: "progress", id, step });
			send({ type: "text", id, text: "done" });
			return;
		case "env":
			send({ type: "text", id, value: process.env[request.name ?? ""] ?? null });
			return;
		case "pid":
			send({ type: "text", id, pid: process.pid });
			return;
		case "hang":
			send({ type: "progress", id, step: 0 });
			return;
		default:
			send({ type: "error", id, error: `unknown request ${request.type}` });
	}
}

// Module marker: top-level `for await` needs module, not script, parsing.
export {};

const decoder = new TextDecoder();
let buffered = "";
for await (const chunk of Bun.stdin.stream()) {
	buffered += decoder.decode(chunk, { stream: true });
	let newline = buffered.indexOf("\n");
	while (newline >= 0) {
		const line = buffered.slice(0, newline).trim();
		buffered = buffered.slice(newline + 1);
		if (line) handle(JSON.parse(line) as Request);
		newline = buffered.indexOf("\n");
	}
}
process.exit(0);
