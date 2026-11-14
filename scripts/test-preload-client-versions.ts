/**
 * `bun test` preload (see the package `bunfig.toml` files): pins every spoofed
 * client version that is otherwise resolved from a third-party registry at run
 * time, so no suite reaches the network and headers stay deterministic. Tests
 * of the lookups themselves unset the variable locally and restore it after.
 */
import { CODEX_CLIENT_VERSION } from "@oh-my-pi/pi-catalog/wire/codex";
import { DEFAULT_GEMINI_CLI_VERSION } from "@oh-my-pi/pi-catalog/wire/gemini-headers";

process.env.PI_AI_GEMINI_CLI_VERSION ||= DEFAULT_GEMINI_CLI_VERSION;
process.env.PI_AI_CODEX_VERSION ||= CODEX_CLIENT_VERSION;
