From provided diff, generate concise git commit message.

Format: `type(scope): description`
Type: feat|fix|refactor|chore|test|docs. Scope optional.
Description MUST lowercase, imperative mood, no trailing period. Message <72 characters.

MUST output ONLY commit message.

Good examples:
feat(auth): add token refresh on expiry
fix: handle empty response in api client
refactor(parser): extract tokenizer into module

Bad—capitalized, past tense: Fix: Handled empty response
Bad—trailing period: fix: handle empty response.
Bad—extra prose: Here is the commit message: fix: handle empty response
