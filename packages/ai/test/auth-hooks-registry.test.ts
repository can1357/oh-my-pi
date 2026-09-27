import { describe, expect, test } from "bun:test";
import { authHookNames, authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import { HOOKS } from "../src/registry/hooks";
import { PROVIDER_REGISTRY } from "../src/registry/registry";

const TABLE_FOR_KIND: Record<string, keyof typeof HOOKS> = {
	env: "env",
	headers: "headers",
	value: "value",
	login: "login",
	refresh: "refresh",
	"after-exchange": "afterExchange",
};

describe("auth rules ↔ hook registry", () => {
	test("every hook name referenced by rules/auth/*.kdl resolves to a registered hook", () => {
		const missing: string[] = [];
		const referenced = authHookNames();
		for (const kind in referenced) {
			const table = HOOKS[TABLE_FOR_KIND[kind]];
			for (const name of referenced[kind]) {
				if (!(name in table)) missing.push(`${kind}:${name}`);
			}
		}
		expect(missing).toEqual([]);
	});

	test("every registered hook is referenced by at least one rule", () => {
		const referenced = new Set<string>();
		const byKind = authHookNames();
		for (const kind in byKind) for (const name of byKind[kind]) referenced.add(`${TABLE_FOR_KIND[kind]}:${name}`);
		const unused: string[] = [];
		for (const table in HOOKS) {
			for (const name in HOOKS[table as keyof typeof HOOKS]) {
				if (!referenced.has(`${table}:${name}`)) unused.push(`${table}:${name}`);
			}
		}
		expect(unused).toEqual([]);
	});

	test("every lazily loaded hook module resolves", async () => {
		const failures: string[] = [];
		for (const table of ["headers", "value", "login", "refresh", "afterExchange"] as const) {
			for (const name in HOOKS[table]) {
				try {
					const hook = await HOOKS[table][name]();
					if (typeof hook !== "function") failures.push(`${table}:${name} is not a function`);
				} catch (error) {
					failures.push(`${table}:${name}: ${error instanceof Error ? error.message : String(error)}`);
				}
			}
		}
		expect(failures).toEqual([]);
	});

	test("registry derives one definition per compiled policy in login-order", () => {
		expect(PROVIDER_REGISTRY.map(p => p.id)).toEqual(authProviders().map(p => p.id));
		for (const definition of PROVIDER_REGISTRY) {
			const policy = authProviders().find(p => p.id === definition.id);
			expect(Boolean(definition.login)).toBe(Boolean(policy?.login));
			expect(definition.callbackPort).toBe(policy?.callbackPort);
		}
	});
});
