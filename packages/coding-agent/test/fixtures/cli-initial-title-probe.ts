import { AgentSession } from "../../src/session/agent-session";

const outputPath = Bun.env.OMP_TITLE_PROBE_PATH;
if (!outputPath) {
	throw new Error("OMP_TITLE_PROBE_PATH is required");
}

let generatedFrom: string | undefined;

AgentSession.prototype.generateTitle = (firstMessage: string): Promise<string | null> => {
	generatedFrom = firstMessage;
	return Promise.resolve("CLI Initial Title");
};

AgentSession.prototype.prompt = async function (): Promise<boolean> {
	void Bun.sleep(100).then(async () => {
		await Bun.write(outputPath, JSON.stringify({ generatedFrom, sessionName: this.sessionName }));
		process.exit(0);
	});
	return true;
};
