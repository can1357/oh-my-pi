/**
 * Cross-process fixture for the close-time draft GC tests (issue #11497). It
 * holds the session file's advisory lock, reports readiness on stdout, then
 * appends one durable message once the parent announces it reached its
 * competing conditional delete. A separate process is what makes the
 * cross-process lock observable from a test: the parent's GC cannot complete
 * while this fixture owns the lock.
 */
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
			if (Date.now() >= deadline) throw new Error("Timed out waiting for the conditional delete attempt");
			Bun.sleepSync(1);
		}
		fs.writeSync(
			fd,
			`${JSON.stringify({
				type: "message",
				id: "external-user-message",
				parentId: null,
				timestamp: new Date().toISOString(),
				message: { role: "user", content: "real question from the other terminal", timestamp: 1 },
			})}\n`,
		);
	});
} finally {
	fs.closeSync(fd);
}
