export interface SSHResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/**
 * Execute an SSH command and return the result
 */
export const sshExec = async (
	sshCmd: string,
	command: string,
	options?: { keepAlive?: boolean },
): Promise<SSHResult> => {
	// Parse SSH command (e.g., "ssh root@1.2.3.4" or "ssh -p 22 root@1.2.3.4")
	const sshParts = sshCmd.split(" ").filter((p) => p);
	const sshBinary = sshParts[0];
	let sshArgs = [...sshParts.slice(1)];

	// Add SSH keepalive options for long-running commands
	if (options?.keepAlive) {
		// ServerAliveInterval=30 sends keepalive every 30 seconds
		// ServerAliveCountMax=120 allows up to 120 failures (60 minutes total)
		sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
	}

	sshArgs.push(command);

	const proc = Bun.spawn([sshBinary, ...sshArgs], {
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	let stdout = "";
	let stderr = "";

	const stdoutReader = proc.stdout.getReader();
	const stderrReader = proc.stderr.getReader();

	// Read stdout
	const stdoutPromise = (async () => {
		const decoder = new TextDecoder();
		while (true) {
			const { done, value } = await stdoutReader.read();
			if (done) break;
			stdout += decoder.decode(value, { stream: true });
		}
	})();

	// Read stderr
	const stderrPromise = (async () => {
		const decoder = new TextDecoder();
		while (true) {
			const { done, value } = await stderrReader.read();
			if (done) break;
			stderr += decoder.decode(value, { stream: true });
		}
	})();

	// Wait for process and streams
	await Promise.all([stdoutPromise, stderrPromise, proc.exited]);

	return {
		stdout,
		stderr,
		exitCode: proc.exitCode || 0,
	};
};

/**
 * Execute an SSH command with streaming output to console
 */
export const sshExecStream = async (
	sshCmd: string,
	command: string,
	options?: { silent?: boolean; forceTTY?: boolean; keepAlive?: boolean },
): Promise<number> => {
	const sshParts = sshCmd.split(" ").filter((p) => p);
	const sshBinary = sshParts[0];

	// Build SSH args
	let sshArgs = [...sshParts.slice(1)];

	// Add -t flag if requested and not already present
	if (options?.forceTTY && !sshParts.includes("-t")) {
		sshArgs = ["-t", ...sshArgs];
	}

	// Add SSH keepalive options for long-running commands
	if (options?.keepAlive) {
		// ServerAliveInterval=30 sends keepalive every 30 seconds
		// ServerAliveCountMax=120 allows up to 120 failures (60 minutes total)
		sshArgs = ["-o", "ServerAliveInterval=30", "-o", "ServerAliveCountMax=120", ...sshArgs];
	}

	sshArgs.push(command);

	const proc = Bun.spawn([sshBinary, ...sshArgs], {
		stdin: options?.silent ? "ignore" : "inherit",
		stdout: options?.silent ? "ignore" : "inherit",
		stderr: options?.silent ? "ignore" : "inherit",
	});

	return proc.exited;
};

/**
 * Copy a file to remote via SCP
 */
export const scpFile = async (sshCmd: string, localPath: string, remotePath: string): Promise<boolean> => {
	// Extract host from SSH command
	const sshParts = sshCmd.split(" ").filter((p) => p);
	let host = "";
	let port = "22";
	let i = 1; // Skip 'ssh'

	while (i < sshParts.length) {
		if (sshParts[i] === "-p" && i + 1 < sshParts.length) {
			port = sshParts[i + 1];
			i += 2;
		} else if (!sshParts[i].startsWith("-")) {
			host = sshParts[i];
			break;
		} else {
			i++;
		}
	}

	if (!host) {
		console.error("Could not parse host from SSH command");
		return false;
	}

	// Build SCP command
	const scpArgs = ["-P", port, localPath, `${host}:${remotePath}`];

	const proc = Bun.spawn(["scp", ...scpArgs], {
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});

	const exitCode = await proc.exited;
	return exitCode === 0;
};
