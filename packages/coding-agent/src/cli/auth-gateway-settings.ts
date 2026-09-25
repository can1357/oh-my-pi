/**
 * Settings declared by this domain (see `config/registry.ts`). Declaration order is the
 * settings-panel order; `config/all-settings.ts` registers every domain.
 */
import { register } from "../config/registry";

// Optional RouteDefinition file used by `omp auth-gateway serve` when `--routes` is omitted.
// Hidden from the UI (no `ui` metadata); populate via config.yml.
export const cfgAuthGatewayRoutesFile = register({ id: "auth.gateway.routesFile", type: "string", default: undefined });
