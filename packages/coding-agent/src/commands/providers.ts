import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import { providersHelp } from "../cli/command-help";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage } from "../sdk";
import type { AuthStorage } from "../session/auth-storage";
import { providersCommand } from "../session/providers-command";

export default class Providers extends Command {
	static description = providersHelp.description;
	static args = {
		action: Args.string({ description: "probe | clear (omit to list cooldowns)", options: ["probe", "clear"] }),
		provider: Args.string({ description: "Provider id" }),
	};
	static flags = { all: Flags.boolean({ description: "Probe all cooldown records" }) };
	static examples = [
		"omp providers",
		"omp providers probe codex-lb",
		"omp providers probe --all",
		"omp providers clear codex-lb",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Providers);
		if (flags.all && (args.action !== "probe" || args.provider))
			throw new Error("--all requires probe without a provider");
		let auth: AuthStorage | undefined;
		let registry: ModelRegistry | undefined;
		try {
			const argv = [args.action, flags.all ? "--all" : args.provider].filter(
				(value): value is string => value !== undefined,
			);
			const output = await providersCommand(argv, async () => {
				const settings = await Settings.init({ cwd: getProjectDir() });
				auth = await discoverAuthStorage(undefined, { settings });
				registry = new ModelRegistry(auth);
				await registry.refresh("offline");
				return registry;
			});
			process.stdout.write(`${output}\n`);
		} finally {
			registry?.stopAvailabilityMonitoring();
			auth?.close();
		}
	}
}
