import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

it("formData", () => {
	const User = type({
		email: "string.email",
		file: "File",
		tags: "Array.liftFrom<string>",
	});

	const parseUserForm = type("FormData.parse").pipe(User);

	const data = new FormData();

	if (process.version.startsWith("v18")) return;

	const file = new File([], "");

	data.append("email", "david@arktype.io");
	data.append("file", file);
	data.append("tags", "typescript");
	data.append("tags", "arktype");

	const out = parseUserForm(data);
	expect(out).toEqual({
		email: "david@arktype.io",
		file,
		tags: ["typescript", "arktype"],
	});

	data.set("email", "david");
	data.set("file", null);
	data.append("tags", file);

	expect(String(parseUserForm(data))).toBe(`email must be an email address (was "david")
file must be a File instance (was a string)
tags[2] must be a string (was Blob)`);
});
