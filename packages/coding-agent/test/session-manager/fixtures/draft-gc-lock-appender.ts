import * as fs from "node:fs";
import { withFileLockSync } from "@oh-my-pi/pi-utils/file-lock";

const sessionPath = process.argv[2];
const deleteAttemptPath = process.argv[3];
if (!sessionPath || !deleteAttemptPath) throw new Error("Expected session and delete-attempt paths");

const fd = fs.openSync(sessionPath, "a");
try {
	withFileLockSync(sessionPath, () => {
		process.stdout.write("ready\n");
		const deadline = Date.now() + 10_000;
		while (!fs.existsSync(deleteAttemptPath)) {
			if (Date.now() >= deadline) throw new Error("Timed out waiting for conditional delete attempt");
			// Cross-process lock integration requires the child to hold ownership until
			// the parent reaches the competing critical section.
			Bun.sleepSync(1);
		}
		fs.writeSync(
			fd,
			`${JSON.stringify({
				type: "message",
				id: "external-user-message",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "real question from terminal B", timestamp: 1 },
			})}\n`,
		);
	});
} finally {
	fs.closeSync(fd);
}
