import { parentPort } from "node:worker_threads";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { readPersistedAgentHistoryInline, type PersistedTranscript } from "./persisted-agents";
import type { HistoryWorkerReply } from "./persisted-history-client";

if (!parentPort) throw new Error("History worker requires a parent port");
const send = (reply: HistoryWorkerReply): void => {
	parentPort!.postMessage(reply);
};
async function load(request: { id: number; transcript: PersistedTranscript }): Promise<void> {
	try {
		const { id, transcript } = request;
		{
			const history = await readPersistedAgentHistoryInline(transcript, () => true);
			send({ id, history });
		}
	} catch (error) {
		send({ id: request.id, error: String(error) });
	}
}
const handle = (message: unknown): void => {
	void load(message as { id: number; transcript: PersistedTranscript });
};
const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(handle);
else parentPort.on("message", handle);
