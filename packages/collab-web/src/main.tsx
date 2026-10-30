import { initializeI18n } from "@oh-my-pi/pi-utils/i18n-browser";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles/tokens.css";
import "./styles/base.css";

void initializeI18n().then(() => {
	const root = document.getElementById("root");
	if (!root) throw new Error("missing #root element");
	createRoot(root).render(<App />);
});
