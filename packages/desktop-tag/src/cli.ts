#!/usr/bin/env bun
import { logger } from "@pk-nerdsaver-ai/pi-utils";

import { TagGatewayServer } from "./gateway";

function main(): void {
	const args = process.argv.slice(2);
	const portArg = args.find(a => a.startsWith("--port="))?.split("=")[1];
	const hostArg = args.find(a => a.startsWith("--host="))?.split("=")[1];
	const port = portArg ? Number.parseInt(portArg, 10) : Number(Bun.env.OMP_DESKTOP_TAG_PORT ?? 18087);
	const hostname = hostArg ?? (Bun.env.OMP_DESKTOP_TAG_HOST || "127.0.0.1");

	const server = new TagGatewayServer({ port, hostname });
	server.start();

	logger.info("ompk-tag running", { url: server.url });
	console.log(`ompk-tag listening at ${server.url}`);

	let stopping = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (stopping) return;
		stopping = true;
		logger.info("Shutting down ompk-tag", { signal });
		await server.stop();
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main();
