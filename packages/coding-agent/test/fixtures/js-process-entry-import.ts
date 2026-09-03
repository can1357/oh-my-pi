import "../../src/cli";

process.stdout.write(process.env.OMP_PROCESS_ENTRY_ENV_PROBE ?? "");
