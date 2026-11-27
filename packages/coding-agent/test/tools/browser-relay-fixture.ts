import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	unpackedExtensionId,
	writeRelayExtension,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/extension-files";
import { writeRelayNativeHost } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/native-host-manifest";
import { NATIVE_HOST } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/protocol";
import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { $ } from "bun";

export interface FixtureRelayExtension {
	dir: string;
	id: string;
	configureProfile(profile: string): Promise<void>;
	dispose(): Promise<void>;
}

/** A real unpacked extension and stdio host, paired only with one another. `root` belongs to the test. */
export async function prepareRelayExtension(root: string, port: number): Promise<FixtureRelayExtension> {
	const dir = path.join(root, "extension");
	await writeRelayExtension(dir, VERSION);
	const id = await unpackedExtensionId(dir);
	if (!id) throw new Error("Missing relay extension directory");
	const [manifest] = await writeRelayNativeHost([id], {
		home: root,
		configHome: root,
		dir: path.join(root, "native-host"),
		command: [
			process.execPath,
			path.resolve(import.meta.dir, "../fixtures/browser-relay-native-host.ts"),
			String(port),
		],
	});
	if (!manifest) throw new Error("No native host manifest for this platform");

	// Unlike macOS/Linux, Windows looks only in the registry, not in --user-data-dir. Give the
	// disposable worker its own host name; never use or replace the user's omp registration.
	let registryKey: string | undefined;
	if (process.platform === "win32") {
		const host = `${NATIVE_HOST}.fixture_${id}`;
		const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${host}`;
		const background = path.join(dir, "background.js");
		const script = await Bun.file(background).text();
		const original = JSON.stringify(NATIVE_HOST);
		if (!script.includes(original)) throw new Error("Cannot locate the installed worker's native host name");
		await Bun.write(background, script.replaceAll(original, JSON.stringify(host)));
		const data = await Bun.file(manifest).json();
		await Bun.write(manifest, JSON.stringify({ ...data, name: host }));
		if ((await $`reg.exe query ${key}`.quiet().nothrow()).exitCode === 0) {
			throw new Error(`Fixture key already exists: ${key}`);
		}
		try {
			await $`reg.exe add ${key} /ve /t REG_SZ /d ${manifest}`.quiet();
			registryKey = key;
		} catch (error) {
			await $`reg.exe delete ${key} /f`.quiet().nothrow();
			throw error;
		}
	}
	return {
		dir,
		id,
		async configureProfile(profile: string) {
			if (process.platform === "win32") return;
			const hosts = path.join(profile, "NativeMessagingHosts");
			await fs.mkdir(hosts, { recursive: true });
			await fs.copyFile(manifest, path.join(hosts, path.basename(manifest)));
		},
		async dispose() {
			if (registryKey) await $`reg.exe delete ${registryKey} /f`.quiet();
		},
	};
}
