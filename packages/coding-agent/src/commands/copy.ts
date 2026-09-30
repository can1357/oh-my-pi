import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { copyHelp as commandHelp } from "../cli/command-help";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { copyTextPersistent } from "../utils/clipboard";
import { registerCopyUrlHandler, resolveCopyBlock } from "../utils/copy-store";

export default class Copy extends Command {
	static description = commandHelp.description;
	static args = {
		url: Args.string({ description: "omp-copy:<payload> URL", required: false }),
	};
	static flags = {
		"install-handler": Flags.boolean({ description: "Register the omp-copy: URL scheme handler (Linux xdg)" }),
		stdin: Flags.boolean({ description: "Read code from standard input instead of a copy URL" }),
	};

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Copy);
		if (flags["install-handler"]) {
			const result = await registerCopyUrlHandler();
			if (result.ok) process.stdout.write(`Registered omp-copy: → ${result.desktopPath}\n`);
			else {
				process.stderr.write(`copy: handler registration failed: ${result.error}\n`);
				process.exitCode = 1;
			}
			return;
		}
		if (flags.stdin) {
			await copyTextPersistent(await Bun.stdin.text());
			return;
		}
		if (!args.url) {
			process.stderr.write("usage: omp copy <omp-copy:payload> | omp copy --install-handler\n");
			process.exitCode = 2;
			return;
		}
		const code = resolveCopyBlock(args.url);
		if (code === undefined) {
			process.stderr.write("copy: invalid or truncated copy target\n");
			process.exitCode = 1;
			return;
		}
		// The URL contains source code. Only the short-lived launcher may carry it
		// in argv; the clipboard owner receives bytes through an anonymous pipe.
		const owner = Bun.spawn([...resolveCliEntryCmd(), "copy", "--stdin"], {
			stdin: "pipe",
			stdout: "ignore",
			stderr: "inherit",
		});
		try {
			owner.stdin.write(code);
			await owner.stdin.end();
			owner.unref();
		} catch (error) {
			owner.kill();
			await owner.exited;
			throw error;
		}
	}
}
