import { runNativeHost } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/native-host";

await runNativeHost(Number(process.argv[2]));
