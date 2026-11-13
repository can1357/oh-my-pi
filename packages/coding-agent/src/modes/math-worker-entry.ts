import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { MATH_RENDERER_ID, type MathWorkerInbound, type MathWorkerOutbound } from "./math-worker-protocol";
import { renderMathImageSvg } from "./mathjax-renderer";

if (!parentPort) throw new Error("Math worker requires a parent port");
const port = parentPort;
const handle = (message: MathWorkerInbound): void => {
	let response: MathWorkerOutbound;
	if (message.type === "ping") response = { type: "pong", id: message.id, epoch: message.epoch };
	else {
		try {
			response = {
				type: "result",
				id: message.id,
				epoch: message.epoch,
				result: renderMathImageSvg(message.request),
			};
		} catch (error) {
			const name =
				error && typeof error === "object" && "name" in error && typeof error.name === "string"
					? error.name
					: "Error";
			const text =
				error && typeof error === "object" && "message" in error && typeof error.message === "string"
					? error.message
					: String(error);
			response = {
				type: "error",
				id: message.id,
				epoch: message.epoch,
				error: { name, message: text.slice(0, 240) },
			};
		}
	}
	port.postMessage(response);
};
port.postMessage({ type: "ready", rendererId: MATH_RENDERER_ID } satisfies MathWorkerOutbound);
const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(message => handle(message as MathWorkerInbound));
else port.on("message", handle);
