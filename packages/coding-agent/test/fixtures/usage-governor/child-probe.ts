import { fstatSync, readdirSync } from "node:fs";

const sockets: number[] = [];
for (const name of readdirSync("/dev/fd")) {
	const fd = Number(name);
	if (!Number.isInteger(fd) || fd < 3) continue;
	try {
		if (fstatSync(fd).isSocket()) sockets.push(fd);
	} catch {}
}
if (sockets.length) throw new Error(`inherited socket descriptors: ${sockets.join(",")}`);

const mode = process.argv[2];
if (mode === "env") {
	console.log(JSON.stringify({ names: Object.keys(process.env).sort(), sockets }));
} else if (mode === "fetch" || mode === "egress") {
	const target = process.argv[3];
	if (mode === "fetch") {
		for (const name of [
			"PI_PROXY",
			"HTTPS_PROXY",
			"HTTP_PROXY",
			"ALL_PROXY",
			"https_proxy",
			"http_proxy",
			"all_proxy",
		]) {
			delete process.env[name];
		}
	}
	try {
		const response = await fetch(target, {
			signal: AbortSignal.timeout(3000),
			headers: process.argv[4] ? { authorization: `Bearer ${process.argv[4]}` } : {},
		});
		console.log(JSON.stringify({ status: response.status, sockets }));
	} catch (error) {
		const e = error as Error & {
			code?: string;
			errno?: number;
			cause?: { code?: string; errno?: number; message?: string };
		};
		console.log(JSON.stringify({ error: e.message, code: e.code, errno: e.errno, cause: e.cause, sockets }));
	}
} else {
	throw new Error(`unknown probe mode ${mode}`);
}
