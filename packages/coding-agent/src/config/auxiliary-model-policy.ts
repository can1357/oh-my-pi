import { register } from "./registry";

/** Restrict judge calls to the active session's provider. */
export const cfgNoJudge = register({ id: "models.noJudge", type: "boolean", default: false });

/** Restrict Spotlight calls to the active session's provider. */
export const cfgNoSpotlight = register({ id: "models.noSpotlight", type: "boolean", default: false });

/** Apply both auxiliary-model provider restrictions. */
export const cfgOffline = register({ id: "models.offline", type: "boolean", default: false });
