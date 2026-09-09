import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";

process.stdout.write(JSON.stringify(isBunTestRuntime()));
