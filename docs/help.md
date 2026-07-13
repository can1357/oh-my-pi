# Built-in feature help

oh-my-pk includes a deterministic feature recommender for discovering capabilities without leaving a session.

## Use it

```text
/help
/help how do I share a live session?
/help can the agent plan before editing files?
/help how do I connect an MCP server?
```

`/help` shows a compact overview of common built-in features. `/help <question>` ranks the closest capabilities and explains:

- what the feature does
- when it is useful
- the command or tool to try
- the local documentation file with full details

The recommender only reports a match when the question shares meaningful feature vocabulary. If there is no close match, the question is not consumed by the help command; submit it normally to ask the agent.

## Examples

| Question | Recommendation |
| --- | --- |
| `How do I share this session with a teammate?` | `/collab`, documented in [`collab.md`](./collab.md) |
| `Can you make a plan before changing files?` | `/plan`, documented in [`session-tree-plan.md`](./session-tree-plan.md) |
| `How do I add an MCP server?` | `/mcp`, documented in [`mcp-config.md`](./mcp-config.md) |
| `How do I find and install a plugin?` | `/marketplace`, documented in [`marketplace.md`](./marketplace.md) |

The catalog is shipped with the coding-agent package, so it works offline and does not require a provider request, network access, or a configured model.
