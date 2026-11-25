import { expect, test } from "bun:test";
import { CombinedAutocompleteProvider } from "@oh-my-pi/pi-coding-agent/autocomplete/autocomplete";

test("narrowing retains hidden skills while approaching the namespace or competing with an alias", async () => {
	const provider = new CombinedAutocompleteProvider(
		[
			{ name: "tool", aliases: ["job"] },
			{ name: "skill:find-jobs", iconName: "search" },
			{ name: "skill:sketch" },
		],
		process.cwd(),
	);
	const values = (query: string) => provider.trySyncSlashCompletion(query)?.items.map(item => item.value);
	expect(values("/job")).toEqual(["job"]);
	expect(values("/jobs")).toEqual(["skill:find-jobs"]);
	expect(provider.trySyncSlashCompletion("/sk")?.items).toEqual([
		{ value: "skill:", label: "skill:", description: "2 skills", iconName: "search" },
	]);
	expect(values("/ske")).toEqual(["skill:sketch"]);
	expect(values("/skill")).toEqual(["skill:"]);
	expect(values("/skill:")).toEqual(["skill:find-jobs", "skill:sketch"]);
	// A mid-prompt lookup neither inherits nor poisons the submitted candidate set.
	expect(values("/job")).toEqual(["job"]);
	expect((await provider.getSuggestions(["say /sket"], 0, 9))?.items[0]?.value).toBe("skill:sketch");
	expect(values("/jobs")).toEqual(["skill:find-jobs"]);
});

test("growing queries rerank underlying commands, refresh usage and live text, and retain registry-order ties", async () => {
	let reads = 0;
	let usage = 1;
	const provider = new CombinedAutocompleteProvider(
		[
			{ name: "model" },
			{
				name: "other",
				aliases: ["m", "modern"],
				description: "Choose",
				getAutocompleteDescription: () => `Mode: ${++reads}`,
			},
			{ name: "action", description: "Modify settings" },
		],
		process.cwd(),
		{ commandUsage: name => (name === "other" ? usage : 0) },
	);
	expect(provider.trySyncSlashCompletion("/m")?.items.map(item => item.value)).toEqual(["m", "model", "action"]);
	expect(provider.trySyncSlashCompletion("/mo")?.items[0]).toMatchObject({ value: "modern", state: "2" });
	usage = 0;
	expect(await provider.getSuggestions(["  /mod"], 0, 6)).toEqual({
		prefix: "  /mod",
		items: [
			{ value: "model", label: "model" },
			{ value: "modern", label: "modern", description: "Mode: 3", nativeDetail: "Choose", state: "3" },
			{ value: "action", label: "action", description: "Modify settings", descriptionMatch: true },
		],
	});
	expect(provider.trySyncSlashCompletion("/modx")).toBeNull();
	expect(provider.trySyncSlashCompletion("/modxx")).toBeNull();
	expect(provider.trySyncSlashCompletion("/modify")?.items[0]?.value).toBe("action");
	expect(reads).toBe(3);
});
