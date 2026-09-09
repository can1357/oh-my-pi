import { parentPort } from "node:worker_threads";
import { installWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { COMPUTER_WORKER_ARG } from "../../src/tools/computer/protocol";
import { startComputerWorker } from "../../src/tools/computer/worker-entry";

if (process.argv[2] !== COMPUTER_WORKER_ARG) throw new Error(`unknown worker selector: ${process.argv[2]}`);
if (!parentPort) throw new Error("computer worker fixture: missing parentPort");
installWorkerInbox(parentPort);
startComputerWorker();
