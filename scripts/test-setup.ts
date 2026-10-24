import { afterEach, beforeEach } from "bun:test";

// Renderer tests start with default targets; custom-link tests opt in explicitly.
const originalLinkEnv = {
	PI_LINK_SCHEME: Bun.env.PI_LINK_SCHEME,
	PI_LINK_HOST: Bun.env.PI_LINK_HOST,
};

beforeEach(() => {
	for (const key of Object.keys(originalLinkEnv)) {
		delete Bun.env[key];
	}
});

afterEach(() => {
	for (const [key, value] of Object.entries(originalLinkEnv)) {
		if (value === undefined) {
			delete Bun.env[key];
		} else {
			Bun.env[key] = value;
		}
	}
});
