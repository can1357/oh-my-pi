// Options page for the OMP Browser Relay extension (plain JS: shipped as-is).
const DEFAULT_PORT = 9224;
const portInput = document.getElementById("port");
const tokenInput = document.getElementById("token");
const status = document.getElementById("status");

chrome.storage.local.get({ port: DEFAULT_PORT, token: "" }).then(stored => {
	portInput.value = String(stored.port);
	tokenInput.value = String(stored.token);
});

document.getElementById("save").addEventListener("click", async () => {
	const port = Number(portInput.value);
	if (!Number.isInteger(port) || port <= 0 || port > 65535) {
		status.textContent = "invalid port";
		return;
	}
	await chrome.storage.local.set({ port, token: tokenInput.value });
	status.textContent = "saved";
	setTimeout(() => {
		status.textContent = "";
	}, 1500);
});
