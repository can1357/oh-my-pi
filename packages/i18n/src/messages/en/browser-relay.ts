export const browserRelay = {
	hint: "The extension connects to a local omp-browser-relay process. Values here must match the flags the relay was started with.",
	labels: { language: "Language", port: "Relay port", token: "Token", tokenOptional: "optional" },
	language: { auto: "Automatic", chinese: "简体中文", english: "English" },
	optionsTitle: "OMP Browser Relay settings",
	save: "Save",
	status: { invalidPort: "invalid port", saved: "saved" },
	title: "OMP Browser Relay",
} as const;
