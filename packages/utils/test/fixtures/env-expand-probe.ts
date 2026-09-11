import { $env } from "@oh-my-pi/pi-utils/env";

// Run with `--no-env-file` so Bun does not autoload/expand the dotenv; env.ts
// must reproduce Bun's `$VAR` expansion for the project `.env` it now owns.
process.stdout.write(
	JSON.stringify({
		api: $env.API ?? null,
		base: $env.BASE ?? null,
		forward: $env.FORWARD ?? null,
		certificate: $env.CERTIFICATE ?? null,
		escaped: $env.ESCAPED ?? null,
	}),
);
