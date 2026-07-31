import { register } from "../config/registry";
import type { PanelSettings } from "./types";

const EMPTY_PANEL_SETTINGS: PanelSettings = { roles: {}, personas: {} };

export const cfgPanel = register({ id: "panel", type: "record", default: EMPTY_PANEL_SETTINGS });
