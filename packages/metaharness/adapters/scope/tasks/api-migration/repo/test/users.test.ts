import { expect, test } from "bun:test";
import { Store } from "../src/store";
import { createUser, getUser, listUsers } from "../src/users";

test("creates, fetches, and lists users", async () => {
	const store = new Store();
	await createUser(store, { id: "u2", name: "Linus", email: "linus@example.com" });
	await createUser(store, { id: "u1", name: "Ada", email: "ada@example.com" });
	expect(await getUser(store, "u1")).toEqual({ id: "u1", name: "Ada", email: "ada@example.com" });
	expect(await getUser(store, "nobody")).toBeUndefined();
	expect((await listUsers(store)).map(user => user.id)).toEqual(["u1", "u2"]);
});

test("surfaces store failures", async () => {
	const store = new Store();
	store.failNext(new Error("disk full"));
	await expect(createUser(store, { id: "u1", name: "Ada", email: "ada@example.com" })).rejects.toThrow("disk full");
});
