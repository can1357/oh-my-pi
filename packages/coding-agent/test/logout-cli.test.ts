import { afterEach, beforeEach, describe, expect, type Mock, mock, spyOn, test } from "bun:test";
import * as readline from "node:readline";
import { PassThrough } from "node:stream";
import {
	AuthStorage,
	type AuthStorageOptions,
	type CredentialsApi,
	type OAuthApi,
	type OAuthCredential,
} from "@oh-my-pi/pi-ai";
import { AuthBrokerClient } from "@oh-my-pi/pi-ai/auth-broker";
import { type LogoutFlowOptions, runLogoutFlow } from "../src/cli/logout-cli";
import { pickIndex, promptLine } from "../src/cli/oauth-terminal";
import { collectLogoutCredentials, toLogoutAccounts } from "../src/slash-commands/helpers/logout";

const ACCESS = "secret-access-token";
const REFRESH = "secret-refresh-token";
const API_KEY = "secret-api-key";

function oauth(identity: Partial<OAuthCredential>): OAuthCredential {
	return { type: "oauth", access: ACCESS, refresh: REFRESH, expires: 0, ...identity };
}

describe("terminal logout", () => {
	let storage: AuthStorage;
	let options: LogoutFlowOptions;
	let output: string;
	let errors: string;
	let refresh: Mock<LogoutFlowOptions["refreshProvider"]>;
	let remove: Mock<CredentialsApi["removeById"]>;
	let access: Mock<OAuthApi["access"]>;
	let login: Mock<OAuthApi["login"]>;
	let accessAll: Mock<OAuthApi["accessAll"]>;
	let accessById: Mock<OAuthApi["accessById"]>;
	let oauthRefresh: Mock<NonNullable<AuthStorageOptions["refreshOAuthCredential"]>>;

	beforeEach(async () => {
		oauthRefresh = mock(async () => {
			throw new Error(REFRESH);
		});
		storage = await AuthStorage.create(":memory:", { refreshOAuthCredential: oauthRefresh });
		output = "";
		errors = "";
		refresh = mock(async () => {});
		remove = spyOn(storage.credentials, "removeById");
		access = spyOn(storage.oauth, "access");
		login = spyOn(storage.oauth, "login");
		accessAll = spyOn(storage.oauth, "accessAll");
		accessById = spyOn(storage.oauth, "accessById");
		options = {
			storage,
			isKnownProvider: provider => provider === "anthropic",
			refreshProvider: refresh,
			pickIndex: async () => {
				throw new Error("Login cancelled");
			},
			promptLine: async () => "y",
			stdout: text => {
				output += text;
			},
			stderr: text => {
				errors += text;
			},
			storageLocation: "/isolated/agent.db",
		};
	});

	afterEach(() => {
		remove.mockRestore();
		access.mockRestore();
		login.mockRestore();
		accessAll.mockRestore();
		accessById.mockRestore();
		storage.close();
		expect(oauthRefresh).not.toHaveBeenCalled();
	});

	test("exact normalized email removes one expired credential and preserves its sibling", async () => {
		await storage.credentials.set("anthropic", [
			oauth({ email: "alice@example.com" }),
			oauth({ email: "alice+other@example.com" }),
		]);
		const target = storage.credentials
			.list("anthropic")
			.find(row => row.credential.type === "oauth" && row.credential.email === "alice@example.com")!;
		const remaining = storage.credentials.list("anthropic").filter(row => row.id !== target.id);
		refresh.mockImplementation(async (provider, mode) => {
			expect(provider).toBe("anthropic");
			expect(mode).toBe("online");
			expect(storage.credentials.list(provider).map(row => row.id)).toEqual(remaining.map(row => row.id));
		});
		expect(await runLogoutFlow(" ANTHROPIC ", " ALICE@EXAMPLE.COM ", options)).toBe(0);
		expect(remove).toHaveBeenCalledWith("anthropic", target.id);
		expect(storage.credentials.list("anthropic").map(row => row.id)).toEqual(remaining.map(row => row.id));
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(access).not.toHaveBeenCalled();
		expect(accessAll).not.toHaveBeenCalled();
		expect(accessById).not.toHaveBeenCalled();
		expect(login).not.toHaveBeenCalled();
		expect(output).toContain("/isolated/agent.db");
		expect(output).toContain("Remaining authentication source: local store");
		for (const secret of [ACCESS, REFRESH, API_KEY]) expect(output + errors).not.toContain(secret);
	});

	test("disabled token is removable by project identity without authentication or exposing its cause", async () => {
		await storage.credentials.set("anthropic", oauth({ projectId: "Project-Only", accountId: "expired-account" }));
		const row = storage.credentials.list("anthropic")[0];
		await storage.credentials.disable(row.id, `invalid_grant: ${ACCESS} ${REFRESH}`);
		expect(storage.credentials.list("anthropic")).toEqual([]);
		const inventory = await collectLogoutCredentials(storage, "anthropic");
		expect(inventory).toEqual([expect.objectContaining({ id: row.id, projectId: "Project-Only", disabled: true })]);
		expect(await runLogoutFlow("anthropic", " project-only ", options)).toBe(0);
		expect(await storage.credentials.listDisabled("anthropic")).toEqual([]);
		expect(remove).toHaveBeenCalledWith("anthropic", row.id);
		expect(access).not.toHaveBeenCalled();
		expect(accessAll).not.toHaveBeenCalled();
		expect(accessById).not.toHaveBeenCalled();
		expect(login).not.toHaveBeenCalled();
		expect(output).toContain("disabled");
		expect(output + errors).not.toContain(ACCESS);
		expect(output + errors).not.toContain(REFRESH);
		expect(output + errors).not.toContain("invalid_grant");
	});

	test("duplicate emails refuse removal and list exact IDs and workspace labels", async () => {
		await storage.credentials.set("anthropic", [
			oauth({ email: "shared@example.com", orgId: "org-a", orgName: "Workspace A" }),
			oauth({ email: "shared@example.com", orgId: "org-b", orgName: "Workspace B" }),
		]);
		const rows = storage.credentials.list("anthropic");
		expect(await runLogoutFlow("anthropic", "SHARED@example.com", options)).toBe(1);
		expect(remove).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(storage.credentials.list("anthropic").map(row => row.id)).toEqual(rows.map(row => row.id));
		expect(errors).toContain("Multiple stored accounts match");
		for (const row of rows) expect(errors).toContain(`oauth #${row.id}`);
		expect(errors).toContain("Workspace A");
		expect(errors).toContain("Workspace B");
	});

	test("numeric row ID is provider scoped and removes only that row", async () => {
		await storage.credentials.set("anthropic", [{ type: "api_key", key: API_KEY }, oauth({ accountId: "sibling" })]);
		await storage.credentials.set("different-provider", oauth({ accountId: "foreign" }));
		const target = storage.credentials.list("anthropic").find(row => row.credential.type === "api_key")!;
		const foreign = storage.credentials.list("different-provider")[0];
		expect(await runLogoutFlow("anthropic", String(foreign.id), options)).toBe(1);
		expect(remove).not.toHaveBeenCalled();
		expect(await runLogoutFlow("anthropic", String(target.id), options)).toBe(0);
		expect(storage.credentials.list("anthropic").map(row => row.credential.type)).toEqual(["oauth"]);
		expect(storage.credentials.list("different-provider")[0].id).toBe(foreign.id);
		expect(refresh).toHaveBeenCalledTimes(1);
		expect(refresh).toHaveBeenCalledWith("anthropic", "online");
		expect(output).toContain(`API key #${target.id}`);
		expect(output + errors).not.toContain(API_KEY);
	});

	test("exact normalized account ID does not match a longer account ID", async () => {
		await storage.credentials.set("anthropic", [oauth({ accountId: "acct" }), oauth({ accountId: "acct-long" })]);
		expect(await runLogoutFlow("anthropic", " ACCT ", options)).toBe(0);
		const remaining = storage.credentials.list("anthropic");
		expect(remaining.map(row => row.credential.type === "oauth" && row.credential.accountId)).toEqual(["acct-long"]);
	});

	test("unknown and substring account selectors never delete", async () => {
		await storage.credentials.set("anthropic", oauth({ email: "alice@example.com" }));
		const row = storage.credentials.list("anthropic")[0];
		for (const selector of ["missing@example.com", "alice", ""]) {
			expect(await runLogoutFlow("anthropic", selector, options)).toBe(1);
		}
		expect(remove).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(storage.credentials.list("anthropic")[0].id).toBe(row.id);
	});

	test("empty and unknown providers fail without deletion", async () => {
		await storage.credentials.set("anthropic", oauth({ email: "alice@example.com" }));
		expect(await runLogoutFlow(" ", undefined, options)).toBe(1);
		expect(errors).toContain("Provider must not be empty");
		expect(await runLogoutFlow("not-a-provider", undefined, options)).toBe(1);
		expect(errors).toContain("Unknown provider");
		expect(remove).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
	});

	test("known provider without stored rows reports a remaining nonstored source", async () => {
		storage.keys.setRuntime("anthropic", API_KEY);
		expect(await runLogoutFlow("anthropic", undefined, options)).toBe(1);
		expect(errors).toContain("No stored credentials for anthropic");
		expect(output).toContain("runtime override (--api-key) (not removed)");
		expect(output + errors).not.toContain(API_KEY);
		expect(remove).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
	});

	test("omitted provider with no rows fails rather than listing configured sources", async () => {
		storage.keys.setRuntime("anthropic", API_KEY);
		const pick = mock(async () => 0);
		options.pickIndex = pick;
		expect(await runLogoutFlow(undefined, undefined, options)).toBe(1);
		expect(errors).toContain("No stored credentials to remove");
		expect(pick).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});

	test("interactive selection includes tombstone-only providers and confirms the exact selected row", async () => {
		await storage.credentials.set("z-provider", oauth({ accountId: "disabled-account" }));
		const target = storage.credentials.list("z-provider")[0];
		await storage.credentials.disable(target.id, REFRESH);
		await storage.credentials.set("anthropic", oauth({ accountId: "untouched" }));
		storage.keys.setRuntime("nonstored-provider", API_KEY);
		let pickCount = 0;
		options.pickIndex = async (_title, labels) => {
			if (pickCount++ === 0) {
				expect(labels).toEqual([expect.stringContaining("(anthropic)"), expect.stringContaining("(z-provider)")]);
				return 1;
			}
			expect(labels[0]).toContain("disabled-account");
			expect(labels[0]).toContain(`#${target.id}`);
			return 0;
		};
		options.promptLine = async question => {
			expect(question).toContain("z-provider");
			expect(question).toContain("disabled-account");
			expect(question).toContain(`#${target.id}`);
			return "yes";
		};
		expect(await runLogoutFlow(undefined, undefined, options)).toBe(0);
		expect(remove).toHaveBeenCalledWith("z-provider", target.id);
		expect(storage.credentials.list("anthropic")[0].credential).toEqual(oauth({ accountId: "untouched" }));
		expect(refresh).toHaveBeenCalledWith("z-provider", "online");
	});

	test("empty confirmation defaults to cancellation without deletion", async () => {
		await storage.credentials.set("anthropic", oauth({ accountId: "retained" }));
		const row = storage.credentials.list("anthropic")[0];
		options.promptLine = async () => "";
		expect(await runLogoutFlow("anthropic", "retained", options)).toBe(0);
		expect(storage.credentials.list("anthropic")[0].id).toBe(row.id);
		expect(remove).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(output).toContain("Logout cancelled");
	});

	test("refresh failure reports the already committed deletion without leaking the exception", async () => {
		await storage.credentials.set("anthropic", oauth({ accountId: "remove-me" }));
		options.storageLocation = "auth broker";
		refresh.mockImplementation(async () => {
			throw new Error(`${ACCESS} ${REFRESH} ${API_KEY}`);
		});
		expect(await runLogoutFlow("anthropic", "remove-me", options)).toBe(1);
		expect(storage.credentials.list("anthropic")).toEqual([]);
		expect(await storage.credentials.listDisabled("anthropic")).toEqual([]);
		expect(output).toContain("from auth broker");
		expect(output).not.toContain("agent.db");
		expect(errors).toContain("Credential removed, but provider refresh failed");
		expect(output).toContain("Remaining authentication source: none");
		for (const secret of [ACCESS, REFRESH, API_KEY]) expect(output + errors).not.toContain(secret);
	});

	test.each([
		["provider", "EOF"],
		["account", "EOF"],
		["confirmation", "EOF"],
		["provider", "Ctrl-C"],
		["account", "Ctrl-C"],
		["confirmation", "Ctrl-C"],
	] as const)("%s input cancelled by %s leaves stored rows untouched", async (stage, cancellation) => {
		await storage.credentials.set("anthropic", oauth({ accountId: "retained" }));
		const row = storage.credentials.list("anthropic")[0];
		const input = new PassThrough();
		const terminalOutput = new PassThrough();
		const rl = readline.createInterface({ input, output: terminalOutput, terminal: false });
		const cancelInput = () => {
			if (cancellation === "EOF") input.end();
			else rl.emit("SIGINT");
		};
		options.pickIndex = (title, labels) => {
			const selection = pickIndex(rl, title, labels);
			cancelInput();
			return selection;
		};
		options.promptLine = question => {
			const answer = promptLine(rl, question);
			cancelInput();
			return answer;
		};
		try {
			expect(
				await runLogoutFlow(
					stage === "provider" ? undefined : "anthropic",
					stage === "confirmation" ? "retained" : undefined,
					options,
				),
			).toBe(0);
			expect(storage.credentials.list("anthropic").map(row => row.id)).toEqual([row.id]);
			expect(await storage.credentials.listDisabled("anthropic")).toEqual([]);
			expect(remove).not.toHaveBeenCalled();
			expect(refresh).not.toHaveBeenCalled();
			expect(output).toContain("Logout cancelled");
			expect(errors).toBe("");
		} finally {
			rl.close();
			input.destroy();
			terminalOutput.destroy();
		}
	});

	test("Escape's existing prompt cancellation rejection is treated as cancellation, not failure", async () => {
		await storage.credentials.set("anthropic", oauth({ accountId: "retained" }));
		options.promptLine = async () => {
			throw new Error("Login cancelled");
		};
		expect(await runLogoutFlow("anthropic", "retained", options)).toBe(0);
		options.pickIndex = async () => {
			throw new Error("Login cancelled");
		};
		expect(await runLogoutFlow(undefined, undefined, options)).toBe(0);
		expect(await runLogoutFlow("anthropic", undefined, options)).toBe(0);
		expect(remove).not.toHaveBeenCalled();
		expect(refresh).not.toHaveBeenCalled();
		expect(errors).toBe("");
	});

	test("disappearance after confirmation is not reported as successful removal", async () => {
		await storage.credentials.set("anthropic", oauth({ accountId: "disappearing" }));
		const row = storage.credentials.list("anthropic")[0];
		options.promptLine = async () => {
			await storage.credentials.removeById("anthropic", row.id);
			return "y";
		};
		expect(await runLogoutFlow("anthropic", "disappearing", options)).toBe(1);
		expect(errors).toContain("Selected credential is no longer stored");
		expect(output).not.toContain("Removed");
		expect(refresh).not.toHaveBeenCalled();
	});

	test("storage deletion failure preserves the row and never refreshes or echoes raw errors", async () => {
		await storage.credentials.set("anthropic", oauth({ accountId: "retained" }));
		const row = storage.credentials.list("anthropic")[0];
		remove.mockImplementation(async () => {
			throw new Error(`${ACCESS} ${REFRESH} ${API_KEY}`);
		});
		expect(await runLogoutFlow("anthropic", "retained", options)).toBe(1);
		expect(storage.credentials.list("anthropic")[0].id).toBe(row.id);
		expect(errors).toContain("Could not delete the stored credential");
		expect(output).not.toContain("Removed");
		expect(refresh).not.toHaveBeenCalled();
		for (const secret of [ACCESS, REFRESH, API_KEY]) expect(output + errors).not.toContain(secret);
	});

	test("older broker deletion support is actionable without reporting a missing or removed credential", async () => {
		await storage.credentials.set("anthropic", oauth({ accountId: "retained" }));
		const row = storage.credentials.list("anthropic")[0];
		options.storageLocation = "auth broker";
		const fetchImpl: typeof fetch = Object.assign(
			async () => Response.json({ error: `${ACCESS} ${REFRESH} ${API_KEY}` }, { status: 404 }),
			{ preconnect: fetch.preconnect },
		);
		const client = new AuthBrokerClient({ url: "http://127.0.0.1:9", token: "unused", fetchImpl });
		remove.mockImplementation(async () => {
			try {
				return (await client.deleteCredential(row.id)).ok;
			} catch (error) {
				if (error instanceof Error) error.message = `${ACCESS} ${REFRESH} ${API_KEY}`;
				throw error;
			}
		});
		expect(await runLogoutFlow("anthropic", "retained", options)).toBe(1);
		expect(storage.credentials.list("anthropic").map(row => row.id)).toEqual([row.id]);
		expect(await storage.credentials.listDisabled("anthropic")).toEqual([]);
		expect(errors).toContain("does not support permanent credential deletion");
		expect(errors).toContain("Update the broker");
		expect(output).not.toContain("Removed");
		expect(errors).not.toContain("no longer stored");
		expect(refresh).not.toHaveBeenCalled();
		for (const secret of [ACCESS, REFRESH, API_KEY]) expect(output + errors).not.toContain(secret);
	});

	test("inventory and prompt failures print only safe errors", async () => {
		const revalidate = spyOn(storage.credentials, "revalidate");
		try {
			revalidate.mockImplementation(async () => {
				throw new Error(REFRESH);
			});
			expect(await runLogoutFlow(undefined, undefined, options)).toBe(1);
			expect(errors).toContain("Could not load stored credentials");
		} finally {
			revalidate.mockRestore();
		}
		await storage.credentials.set("anthropic", oauth({ accountId: "retained" }));
		options.promptLine = async () => {
			throw new Error(API_KEY);
		};
		expect(await runLogoutFlow("anthropic", "retained", options)).toBe(1);
		expect(errors).toContain("Could not confirm credential removal");
		expect(remove).not.toHaveBeenCalled();
		for (const secret of [ACCESS, REFRESH, API_KEY]) expect(output + errors).not.toContain(secret);
	});

	test("registered OAuth storage alias removes the canonical provider row", async () => {
		await storage.credentials.set("canonical-provider", oauth({ accountId: "account" }));
		const row = storage.credentials.list("canonical-provider")[0];
		options.resolveProvider = id => (id === "oauth-alias" ? "canonical-provider" : id);
		expect(await runLogoutFlow("oauth-alias", "account", options)).toBe(0);
		expect(remove).toHaveBeenCalledWith("canonical-provider", row.id);
		expect(refresh).toHaveBeenCalledWith("canonical-provider", "online");
	});

	test("shared labels preserve active workspace gating in the TUI", async () => {
		await storage.credentials.set("anthropic", [
			oauth({ email: "shared@example.com", orgId: "org-a", orgName: "Workspace A" }),
			oauth({ email: "shared@example.com", orgId: "org-b", orgName: "Workspace B" }),
		]);
		const accounts = toLogoutAccounts("anthropic", storage.credentials.list("anthropic"), {
			activeIdentity: { email: "shared@example.com", orgId: "org-b" },
		});
		expect(accounts.map(row => ({ label: row.label, active: row.active }))).toEqual([
			{ label: "shared@example.com (Workspace B)", active: true },
			{ label: "shared@example.com (Workspace A)", active: false },
		]);
	});
});
