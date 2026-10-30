---
description: "Do not extract 1-2 line functions that only wrap an expression — inline them"
condition:
  # A lexical approximation of "a local function whose body is one expression": each alternative
  # starts at a line start or after `;`, `{`, `}`, so exported names, callbacks, object and public
  # class members, and if/try/catch blocks don't match. Every whitespace run sits between fixed
  # tokens, so a failed match costs linear time.
  # function declaration whose body is one return (not a type guard)
  - "(?m)(?:^|[;{}])[ \\t]*(?:async[ \\t]+)?function(?:[ \\t]*\\*[ \\t]*|[ \\t]+)[\\w$]+\\s*(?:<[^(){};]*>\\s*)?\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?\\{\\s*return [^;{}\\n]+;?\\s*\\}"
  # const/let/var bound to a one-expression arrow
  - "(?m)(?:^|[;{}])[ \\t]*(?:const|let|var)\\s+[\\w$]+\\s*=\\s*(?:async\\s+)?(?:<[^(){};]*>\\s*)?(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|[a-zA-Z_$][\\w$]*\\s*)=>\\s*[^{\\s][^{\\n]*$"
  # const/let/var bound to an arrow or function expression whose body is one return
  - "(?m)(?:^|[;{}])[ \\t]*(?:const|let|var)\\s+[\\w$]+\\s*=\\s*(?:async\\s+)?(?:function\\b[^(]*\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|(?:<[^(){};]*>\\s*)?(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|[a-zA-Z_$][\\w$]*\\s*)=>\\s*)\\{\\s*return [^;{}\\n]+;?\\s*\\}"
  # private class method, getter or arrow field whose body is one return or one expression
  - "(?m)(?:^|[;{}])[ \\t]*(?:(?:private[ \\t]+(?:static[ \\t]+)?(?:async[ \\t]+)?(?:get[ \\t]+)?[\\w$]+|(?:static[ \\t]+)?(?:async[ \\t]+)?(?:get[ \\t]+)?#[\\w$]+)\\s*(?:<[^(){};]*>\\s*)?\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?\\{\\s*return [^;{}\\n]+;?\\s*\\}|(?:private[ \\t]+(?:static[ \\t]+)?(?:readonly[ \\t]+)?[\\w$]+|(?:static[ \\t]+)?(?:readonly[ \\t]+)?#[\\w$]+)\\s*(?::[^=\\n]+)?=\\s*(?:async\\s+)?(?:<[^(){};]*>\\s*)?(?:\\((?:[^()]|\\((?:[^()]|\\([^()]*\\))*\\))*\\)\\s*(?::\\n?(?!\\s*(?:asserts\\s+)?[\\w$]+\\s+is\\s)(?:[^{};=\\n]|=>|\\{[^{}\\n]*\\})*)?|[a-zA-Z_$][\\w$]*\\s*)=>\\s*(?:\\{\\s*return [^;{}\\n]+;?\\s*\\}|[^{\\s][^{\\n]*$))"
scope: "tool:edit(*.ts), tool:edit(*.tsx), tool:write(*.ts), tool:write(*.tsx)"
interruptMode: never
---

Inline functions whose whole body: one expression or `return`, unless name creates a durable contract.

## Why

- One-line wrappers: no real behavior.
- Readers: jump to verify trivial code.
- Signature: freezes shape too early.
- Inline expressions: better search and type flow.

## Avoid

```typescript
// Bad — pure rename, no behavior added.
function isEmpty(value: string): boolean {
	return value.length === 0;
}

const getDisplayName = (user: User) => user.profile.displayName;

function double(value: number) {
	return value * 2;
}

if (isEmpty(name)) { ... }
```

## Use

```typescript
if (name.length === 0) { ... }
const displayName = user.profile.displayName;
const doubled = value * 2;
```

## Allowed tiny functions

- Three or more call sites need lockstep behavior.
- Exported name: stable domain concept.
- Callback identity matters.
- Type guard preserves narrowing.
- Public API, test seam, or DI boundary needs indirection.
- Names non-obvious formula or magic-constant computation the inlined expression would not explain alone.

If none apply, inline it.
