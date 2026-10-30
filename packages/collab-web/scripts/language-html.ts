import * as fs from "node:fs";
import * as path from "node:path";
import { browserLanguagePackScript } from "@oh-my-pi/pi-utils/browser-i18n";
import { getLanguage, initializeI18n } from "@oh-my-pi/pi-utils/i18n";

const root = path.resolve(import.meta.dir, "..");
const mode = process.argv[2];
await initializeI18n();
const language = getLanguage();
const source = path.join(root, mode === "dev" ? "index.html" : "dist/index.html");
const html = (await Bun.file(source).text())
	.replace(/<html\b[^>]*>/i, `<html lang="${language}">`)
	.replace(/<head>/i, `<head>${browserLanguagePackScript()}`);

if (mode === "dev") {
	const temporary = path.join(root, `.omp-i18n.${process.pid}.html`);
	await Bun.write(temporary, html);
	const cleanup = () => {
		try {
			fs.unlinkSync(temporary);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	};
	process.on("exit", cleanup);
	try {
		const child = Bun.spawn([process.execPath, temporary, ...process.argv.slice(3)], {
			cwd: root,
			stdin: "inherit",
			stdout: "inherit",
			stderr: "inherit",
		});
		const interrupt = () => child.kill("SIGINT");
		const terminate = () => child.kill("SIGTERM");
		process.on("SIGINT", interrupt);
		process.on("SIGTERM", terminate);
		try {
			process.exitCode = await child.exited;
		} finally {
			process.off("SIGINT", interrupt);
			process.off("SIGTERM", terminate);
		}
	} finally {
		process.off("exit", cleanup);
		cleanup();
	}
} else {
	await Bun.write(source, html);
}
