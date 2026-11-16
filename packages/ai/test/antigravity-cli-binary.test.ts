import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ensureAgyInstalled, updateAgyBinary } from "../src/providers/antigravity-cli/binary";
import type { FetchImpl } from "../src/types";

/** Serves a release manifest and archive in memory without running an installer or contacting Google. */
async function release(
	version: string,
	executable: string,
	checksum?: string,
): Promise<{ fetch: FetchImpl; requests: string[] }> {
	const payload = await new Bun.Archive({ antigravity: executable }, { compress: "gzip" }).bytes();
	const requests: string[] = [];
	const manifest = {
		version,
		url: `https://storage.googleapis.com/antigravity-public/${version}/cli.tar.gz`,
		sha512: checksum ?? new Bun.CryptoHasher("sha512").update(payload).digest("hex"),
	};
	const fetchRelease: FetchImpl = async input => {
		const url = input instanceof Request ? input.url : String(input);
		requests.push(url);
		return url.endsWith(".json") ? Response.json(manifest) : new Response(payload);
	};
	return { fetch: fetchRelease, requests };
}

it("concurrent first-use requests install one verified executable without running the profile installer", async () => {
	using temp = TempDir.createSync("@omp-agy-download-");
	const directory = temp.join("bin");
	const remote = await release("1.5.9", "downloaded executable bytes");
	const paths = await Promise.all([
		ensureAgyInstalled(directory, remote.fetch),
		ensureAgyInstalled(directory, remote.fetch),
	]);
	expect(paths[0]).toBe(paths[1]);
	expect(await Bun.file(paths[0]!).text()).toBe("downloaded executable bytes");
	expect(remote.requests.filter(url => url.endsWith(".tar.gz"))).toHaveLength(1);
	await ensureAgyInstalled(directory, remote.fetch);
	expect(remote.requests).toHaveLength(2);
});

it("a corrupt update preserves the previous binary and a subsequent valid release replaces only the current pointer", async () => {
	using temp = TempDir.createSync("@omp-agy-upgrade-");
	const directory = temp.join("bin");
	const initial = await release("1.5.9", "version one");
	const original = await ensureAgyInstalled(directory, initial.fetch);
	await Bun.write(path.join(directory, "install.json"), JSON.stringify({ version: "1.5.9", checkedAt: 0 }));
	const corrupt = await release("1.6.0", "version two", "0".repeat(128));
	await expect(updateAgyBinary(directory, corrupt.fetch)).rejects.toThrow("SHA-512");
	expect(await Bun.file(original).text()).toBe("version one");
	expect((await Bun.file(path.join(directory, "install.json")).json()).version).toBe("1.5.9");
	const valid = await release("1.6.0", "version two");
	const upgraded = await updateAgyBinary(directory, valid.fetch);
	expect(upgraded).not.toBe(original);
	expect(await Bun.file(upgraded).text()).toBe("version two");
	expect(await Bun.file(original).text()).toBe("version one");
	expect(await ensureAgyInstalled(directory, valid.fetch)).toBe(upgraded);
});
