// Options page for the OMP Browser Relay extension (plain JS: shipped as-is).
const DEFAULT_PORT = 9224;
const MESSAGES = /*__OMP_MESSAGES__*/{};
const portInput = document.getElementById("port");
const tokenInput = document.getElementById("token");
const languageInput = document.getElementById("language");
const status = document.getElementById("status");

function normalizeLocale(value) {
	const normalized = String(value || "").replaceAll("_", "-").toLowerCase();
	if (normalized === "zh" || normalized === "zh-cn" || normalized.startsWith("zh-cn-")) return "zh-CN";
	if (normalized === "en" || normalized.startsWith("en-")) return "en";
	return undefined;
}

function chooseLocale(preference) {
	if (preference === "en" || preference === "zh-CN") return preference;
	for (const candidate of navigator.languages || []) {
		const locale = normalizeLocale(candidate);
		if (locale) return locale;
	}
	return "en";
}

function text(key, locale) {
	let value = MESSAGES[locale];
	for (const part of key.split(".")) value = value && value[part];
	return typeof value === "string" ? value : key;
}

function applyLocale(preference) {
	const locale = chooseLocale(preference);
	document.documentElement.lang = locale;
	for (const element of document.querySelectorAll("[data-i18n]")) {
		element.textContent = text(element.dataset.i18n, locale);
	}
	languageInput.value = preference;
	return locale;
}

let activeLocale = "en";

chrome.storage.local.get({ port: DEFAULT_PORT, token: "", locale: "auto" }).then(stored => {
	portInput.value = String(stored.port);
	tokenInput.value = String(stored.token);
	languageInput.value = stored.locale;
	activeLocale = applyLocale(stored.locale);
});

languageInput.addEventListener("change", async () => {
	await chrome.storage.local.set({ locale: languageInput.value });
	activeLocale = applyLocale(languageInput.value);
});

document.getElementById("save").addEventListener("click", async () => {
	const port = Number(portInput.value);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		status.textContent = text("browserRelay.status.invalidPort", activeLocale);
		return;
	}
	await chrome.storage.local.set({ port, token: tokenInput.value });
	status.textContent = text("browserRelay.status.saved", activeLocale);
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
});
