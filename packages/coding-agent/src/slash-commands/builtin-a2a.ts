/**
 * `/a2a` — register remote A2A agents for the task tool.
 *
 * `add <url>` reads the remote AgentCard and registers one runtime agent per
 * card skill as `a2a:<skill id>` in the session's in-memory bridge. The agents
 * are not files: they exist for this session only, and the task tool routes a
 * spawn of one to the remote JSON-RPC endpoint instead of a local subagent.
 */
import { addA2aAgentsFromUrl } from "../a2a/agent-bridge";
import { readLiveBridges } from "../a2a/server";
import { cardRequiresBearer } from "../a2a/client";
import { commandConsumed, parseSubcommand, usage } from "./helpers/parse";
import type { SlashCommandSpec } from "./types";

const USAGE = [
	"Usage:",
	"  /a2a add <url> [--token <token>]  register the skills of a remote agent card",
	"  /a2a auto [--token <token>]      register every live local bridge (a2a-bridges.json)",
	"  /a2a list                        show the registered remote agents",
	"  /a2a remove <name>               forget one (`a2a:<skill>` or `<skill>`)",
].join("\n");

interface ParsedAddArgs {
	url?: string;
	token?: string;
	error?: string;
}

function parseAddArgs(rest: string): ParsedAddArgs {
	const tokens = rest.trim().split(/\s+/).filter(Boolean);
	const parsed: ParsedAddArgs = {};
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index]!;
		if (token === "--token") {
			const value = tokens[++index];
			if (!value || value.startsWith("--")) return { error: "--token needs a value" };
			parsed.token = value;
			continue;
		}
		if (parsed.url !== undefined) return { error: `Unexpected argument: ${token}` };
		parsed.url = token;
	}
	return parsed;
}

export const BUILTIN_A2A_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "a2a",
		description: "Register remote A2A agents that the task tool can spawn",
		acpDescription: "Register remote A2A agents",
		allowArgs: true,
		subcommands: [
			{ name: "add", description: "Register the skills of a remote agent card", usage: "<url> [--token <token>]" },
			{ name: "list", description: "Show the registered remote agents" },
			{ name: "remove", description: "Forget one registered remote agent", usage: "<name>" },
		],
		subcommandOptional: true,
		getTuiAutocompleteDescription: runtime => {
			const count = runtime.ctx.session.a2aBridge.list().length;
			return count === 0 ? "No remote A2A agents" : `${count} remote A2A agent${count === 1 ? "" : "s"}`;
		},
		handle: async (command, runtime) => {
			const { verb, rest } = parseSubcommand(command.args);
			const bridge = runtime.session.a2aBridge;
			if (!verb || verb === "list" || verb === "status") {
				const agents = bridge.list();
				if (agents.length === 0) {
					await runtime.output("No remote A2A agents. Use `/a2a add <url>` to register one.");
					return commandConsumed();
				}
				const lines = agents.map(
					agent => `${agent.name}  —  ${agent.description}  (${agent.url}, card ${agent.cardName})`,
				);
				await runtime.output(lines.join("\n"));
				return commandConsumed();
			}
			if (verb === "auto") {
				const parsed = parseAddArgs(rest);
				if (parsed.error) return usage(parsed.error, runtime);
				const token = parsed.token;
				try {
					const live = await readLiveBridges(runtime.settings.getAgentDir());
					if (live.size === 0) {
						await runtime.output("No other live local A2A bridges found.");
						return commandConsumed();
					}
					const lines: string[] = [];
					for (const entry of live.values()) {
						const url = `http://127.0.0.1:${entry.port}/`;
						try {
							const result = await addA2aAgentsFromUrl({
								url,
								token,
								bridge,
								agentDir: runtime.settings.getAgentDir(),
								settings: runtime.settings,
							});
							lines.push(`${url} — ${result.added.map(a => a.name).join(", ")}`);
						} catch (error) {
							lines.push(`${url} — failed: ${error instanceof Error ? error.message : String(error)}`);
						}
					}
					await runtime.output(lines.join("\n"));
				} catch (error) {
					await runtime.output(`a2a auto failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				return commandConsumed();
			}
			if (verb === "add") {
				const parsed = parseAddArgs(rest);
				if (parsed.error || parsed.url === undefined) {
					return usage(parsed.error ?? USAGE, runtime);
				}
				try {
					const result = await addA2aAgentsFromUrl({
						bridge,
						url: parsed.url,
						token: parsed.token,
						agentDir: runtime.settings.getAgentDir(),
						settings: runtime.settings,
						signal: runtime.signal,
					});
					const lines = result.added.map(
						agent => `Registered ${agent.name} — ${agent.description} (${agent.url})`,
					);
					if (result.added.length === 0) {
						lines.push(`Card ${result.card.name} listed no skills; nothing to register.`);
					} else {
						lines.push(
							`Spawn it with the task tool: agent \`${result.added.map(agent => agent.name).join("`, `")}\`.`,
						);
						if (cardRequiresBearer(result.card) && result.added[0]?.token === undefined) {
							lines.push(
								"This card declares bearer auth but no token was resolved; pass `--token` or set `a2a.token`.",
							);
						}
					}
					await runtime.output(lines.join("\n"));
					return commandConsumed();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					await runtime.output(`A2A registration failed: ${message}`);
					return commandConsumed({ failed: true });
				}
			}
			if (verb === "remove") {
				const name = rest.trim();
				if (!name) return usage(USAGE, runtime);
				const target = name.startsWith("a2a:") ? name : `a2a:${name}`;
				if (!bridge.remove(target)) {
					await runtime.output(`No registered remote agent: ${target}`);
					return commandConsumed({ failed: true });
				}
				await runtime.output(`Forgot ${target}.`);
				return commandConsumed();
			}
			return usage(USAGE, runtime);
		},
	},
];
