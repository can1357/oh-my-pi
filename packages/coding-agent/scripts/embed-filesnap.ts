import { createHash } from "node:crypto";
import * as path from "node:path";
import { resolveFilesnapNpmBinary } from "../src/utils/filesnap-npm";

/** Embed the target's official npm executable, never the build host's executable. */
export async function createFilesnapEmbedPlugin(target?: Bun.Build.CompileTarget): Promise<Bun.BunPlugin> {
	const parts = target?.split("-");
	const platform = parts ? (parts[1] === "windows" ? "win32" : parts[1]!) : process.platform;
	const arch = parts ? parts[2]! : process.arch;
	let binary: string;
	try {
		binary = resolveFilesnapNpmBinary(platform, arch);
	} catch (cause) {
		throw new Error(
			`Cannot embed filesnap for ${platform}/${arch}. Install cross-platform dependencies with bun install --frozen-lockfile --os='*' --cpu='*'.`,
			{ cause },
		);
	}
	const license = await Bun.file(path.join(import.meta.dir, "../vendor/filesnap/LICENSE")).text();
	const notice = await Bun.file(path.join(import.meta.dir, "../vendor/filesnap/NOTICE")).text();
	const sha256 = createHash("sha256")
		.update(await Bun.file(binary).bytes())
		.digest("hex");
	return {
		name: "filesnap-executable",
		setup(build) {
			build.onLoad({ filter: /[/\\]filesnap-embedded\.ts$/ }, () => ({
				loader: "ts",
				contents: `import binary from ${JSON.stringify(binary)} with { type: "file" };\nexport const embeddedFilesnap = { path: binary, sha256: ${JSON.stringify(sha256)}, license: ${JSON.stringify(license)}, notice: ${JSON.stringify(notice)} };`,
			}));
		},
	};
}
