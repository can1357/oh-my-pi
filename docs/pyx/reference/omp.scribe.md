# `omp.scribe`

Use `omp.scribe` when an extension must produce prompt text from structured values without introducing time, environment, or I/O dependencies. You can compile a template once with `Template`, render it repeatedly, and optionally normalize stable prompt text before it is hashed or journaled.

```python
from omp.scribe import Template

summary = Template(
    "{% if files %}Changed files:\n{{ files | bullets }}{% endif %}",
    name="change-summary",
)

text = summary.render({"files": ["src/api.py", "tests/test_api.py"]})
```

The language uses `{{ expression }}`, `{% statement %}`, and `{# comment #}` delimiters. Rendering accepts JSON-shaped Python data and has no extension-defined helper registry. To contribute the result to the prompt, see [`omp.prompts`](omp.prompts.md).

## Template language at a glance

Statements include `if`/`elif`/`else`, `for`, `set`, `raw`, `xml`, and `codeblock`. Expressions support literals, dotted and indexed lookup, optional chaining (`value?.member`), comparisons, boolean operators, membership, numeric `+` and `-`, string concatenation with `~`, conditional expressions, function calls, and filter pipelines.

The fixed filters are `join`, `length`, `default`, `pluralize`, `json`, `escape_xml`, `trim`, `indent`, and `bullets`. The fixed function is `table`; `xml` and `codeblock` are block helpers. Missing data is false in conditions, but sending an unresolved value to output or another strict operation raises `TemplateError`. Use optional chaining and `default` where absence is expected.

Props may contain `None`, booleans, signed 64-bit integers, floats, strings, lists or tuples, and dictionaries whose keys are strings. Nested values follow the same rules. Maps render and iterate in key order.

## Reference

### `omp.scribe.Template`

```python
Template(source: str, *, name: str = "template")
```

Compiles an immutable template for repeated deterministic renders.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `source` | `str` | Template source written in the scribe language. |
| `name` | `str` | Diagnostic name included in compile and render errors. |

**Returns**

A compiled `Template` instance.

**Raises**

| Exception | Condition |
| --- | --- |
| [`TemplateError`](#ompscribetemplateerror) | The source has invalid syntax or refers to an unknown helper. |

#### `Template.name`

```python
@property
def name(self, /) -> str:
    ...
```

Returns the diagnostic name supplied when the template was compiled.

#### `Template.referenced_keys`

```python
@property
def referenced_keys(self, /) -> tuple:
    ...
```

Returns sorted, unique top-level prop names discovered during compilation. Local loop and assignment names are not top-level props.

#### `Template.render`

```python
def render(self, /, props: dict | None = None) -> str:
    ...
```

Renders the compiled template against one prop dictionary. Passing `None` is equivalent to an empty prop mapping.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `props` | `dict | None` | String-keyed, JSON-shaped values available to the template. |

**Returns**

The rendered Unicode string. This method does not call [`canonicalize`](#ompscribecanonicalize).

**Raises**

| Exception | Condition |
| --- | --- |
| [`TemplateError`](#ompscribetemplateerror) | An undefined value reaches a strict operation or an expression receives an incompatible shape. |
| `TypeError` | A dictionary key is not a string or a prop value is outside the supported value model. |
| `OverflowError` | An integer does not fit the signed 64-bit value model. |

```python
from omp.scribe import Template

template = Template(
    "{{ count | pluralize('result') }}{% if note %}: {{ note }}{% endif %}",
    name="result-count",
)
assert template.referenced_keys == ("count", "note")
message = template.render({"count": 2, "note": "ready"})
```

### `omp.scribe.TemplateError`

```python
class TemplateError(OmpError):
    ...
```

Covers scribe compilation and rendering failures.

A diagnostic identifies the template name and source location. Syntax errors and unknown helpers are detected while constructing `Template`; data-dependent failures occur during `render`.

### `omp.scribe.render`

```python
def render(
    source: str,
    props: dict[str, Any] | None = None,
    *,
    name: str = "template",
) -> str:
    ...
```

Compiles and renders a template in one call.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `source` | `str` | Scribe template source. |
| `props` | `dict[str, Any] | None` | String-keyed render values; `None` supplies no props. |
| `name` | `str` | Name used in diagnostics. |

**Returns**

The rendered string, without canonicalization.

**Raises**

The same [`TemplateError`](#ompscribetemplateerror), `TypeError`, and `OverflowError` conditions as compiling a [`Template`](#ompscribetemplate) and calling `Template.render`.

Use this convenience for occasional templates. Keep a compiled `Template` when the same source is rendered more than once.

```python
from omp.scribe import render

heading = render(
    "{% xml \"context\" %}{{ body }}{% endxml %}",
    {"body": "Review only the changed API."},
    name="review-context",
)
```

### `omp.scribe.canonicalize`

```python
def canonicalize(text: str) -> str:
    ...
```

Applies omp's prompt-text normalization pass to already rendered text.

Outside fenced and inline code, the pass removes HTML comments, trims line endings, reduces repeated blank lines, tightens GitHub-Flavored Markdown table separators, and normalizes selected RFC 2119 wording. Code content remains byte-sensitive and is left alone. Canonicalization is explicit; neither `Template.render` nor `render` invokes it.

**Parameters**

| Name | Type | Meaning |
| --- | --- | --- |
| `text` | `str` | Rendered prompt text to normalize. |

**Returns**

The canonical string.

```python
from omp.scribe import canonicalize, render

body = render("Policy:\n\n\n{{ policy }}", {"policy": "You MUST NOT skip review."})
stable_body = canonicalize(body)
```
