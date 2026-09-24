import { createRoot } from "react-dom/client";
import { App } from "./app";
import { CollabI18nProvider } from "./lib/i18n";
import "./styles/tokens.css";
import "./styles/base.css";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root element");
createRoot(root).render(
	<CollabI18nProvider>
		<App />
	</CollabI18nProvider>,
);
