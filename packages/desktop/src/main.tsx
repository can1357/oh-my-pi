import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHashRouter, RouterProvider } from "react-router";
import { App } from "./app";
import { ManageRoute } from "./routes/manage";
import { OnboardingRoute } from "./routes/onboarding";
import { ProbeRoute } from "./routes/probe";
import { SessionRoute } from "./routes/session";
import { ContextMenuProvider } from "./shell/contextMenu";
import { installDiagnostics } from "./shell/diagnostics";
import "./styles/index.css";

/**
 * Hash router, not browser history: Tauri serves the frontend from `tauri://`
 * (and `http://tauri.localhost` on Windows), where path-based routing needs
 * server-side rewrites that a static bundle has no way to provide.
 */
const router = createHashRouter([
	{
		path: "/",
		element: <App />,
		children: [
			{ index: true, element: <SessionRoute /> },
			{ path: "session/:tabId", element: <SessionRoute /> },
			{ path: "manage", element: <ManageRoute /> },
			{ path: "onboarding", element: <OnboardingRoute /> },
			{ path: "probe", element: <ProbeRoute /> },
		],
	},
]);

// Before the render, so a failure during the first render is still reported.
installDiagnostics();

const root = document.getElementById("root");
if (!root) throw new Error("#root missing from index.html");

createRoot(root).render(
	<StrictMode>
		{/* Above the router: every route is a child of `App`, and `App` itself
		    needs the menu for the empty space between its columns. */}
		<ContextMenuProvider>
			<RouterProvider router={router} />
		</ContextMenuProvider>
	</StrictMode>,
);
