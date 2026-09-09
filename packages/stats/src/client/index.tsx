import "./styles.css";
// Side-effect import: registers all Chart.js scales/elements/plugins exactly
// once before any chart renders. Without it the first chart throws
// "category is not a registered scale" and unmounts the whole app.
import "./data/charts";
import { createRoot } from "react-dom/client";
import App from "./App";

const root = createRoot(document.getElementById("root")!);
root.render(<App />);
