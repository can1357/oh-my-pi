# User Prompt Plugin

Interactive user prompting tool for gathering user input during agent execution.

## Installation

```bash
omp install @oh-my-pi/user-prompt
```

## Tool

### `user_prompt`

Asks the user questions during execution and returns their response. Useful for:

- Gathering user preferences or requirements
- Clarifying ambiguous instructions
- Getting decisions on implementation choices
- Offering choices about what direction to take

## Parameters

| Parameter  | Type    | Required | Description                                   |
| ---------- | ------- | -------- | --------------------------------------------- |
| `question` | string  | Yes      | The question to ask the user                  |
| `options`  | array   | Yes      | Array of `{label: string}` options to present |
| `multi`    | boolean | No       | Allow multiple selections (default: false)    |

## Usage Notes

- Users can always select "Other" to provide custom text input
- Use `multi: true` to allow multiple answers to be selected
- If you recommend a specific option, make that the first option and add "(Recommended)" at the end of the label

## Examples

### Single-choice question

```json
{
   "question": "Which database would you like to use?",
   "options": [{ "label": "PostgreSQL (Recommended)" }, { "label": "MySQL" }, { "label": "SQLite" }, { "label": "MongoDB" }]
}
```

### Multi-select question

```json
{
   "question": "Which features should I implement?",
   "options": [
      { "label": "Authentication" },
      { "label": "API endpoints" },
      { "label": "Database models" },
      { "label": "Unit tests" },
      { "label": "Documentation" }
   ],
   "multi": true
}
```

## Response Format

The tool returns the user's selection in a structured format:

- **Single selection**: `"User selected: PostgreSQL (Recommended)"`
- **Multi-selection**: `"User selected: Authentication, API endpoints, Unit tests"`
- **Custom input**: `"User provided custom input: Use Redis for caching"`
- **Cancelled**: `"User cancelled the selection"`

## How It Works

The plugin hooks into pi's interactive mode at runtime to provide custom TUI components. It:

1. Dynamically imports pi's theme for consistent styling
2. Locates the InteractiveMode instance to access the editor container
3. Swaps in custom components (MultiSelectList, SelectWithInput) when prompting
4. Restores the normal editor when done

This approach provides a seamless, native-feeling UI without requiring upstream changes to pi.
