//! Rendering tabs: Markdown, LaTeX, Mermaid, Graphviz, and the live editor
//! preview sync shared by the gallery.

use omp_tui::{Size, Ui};

pub const MARKDOWN_TAB: &str = r#"# Rendering Gallery

Everything below is one `<md>` node: **bold**, *italic*, ~~strike~~,
`code`, [a link](https://example.com/docs), a bare https://example.com
autolink, and color chips for #C5FFD6, #4A90D9, and `#fff`.

> Quotes wrap with a rail — *and inline styles survive inside them.*

| Feature | State | Notes |
| --- | --- | --- |
| tables | done | box borders, fixed column widths |
| math | done | inline and display |
| mermaid | done | fenced blocks |
| graphviz | done | `dot`, `graphviz`, and `gv` fences |

```rust
fn main() {
    println!("fenced code keeps its fences");
}
```

├── markdown
│   ├── inline.rs
│   └── table.rs
└── latex

---

1. ordered
2. lists
   - with nesting
"#;

pub const MATH_TAB: &str = r"# Math

Inline: $e^{i\pi} + 1 = 0$, fonts $\mathbb{R}^n \to \mathcal{H}$,
scripts $x_i^2$, and currency stays put: $5 and $10.

$$
x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}
$$

$$
f(x) = \begin{cases} x^2 & x > 0 \\ 0 & \text{otherwise} \end{cases}
$$

$$
\sum_{i=0}^{n} x_i \qquad \int_a^b f(x)\,dx \qquad \prod_{k=1}^{n} (1 + x_k)
$$

$$
\underbrace{a + b}_{\text{sum}} \qquad \left( \frac{1}{2} \right)^2
$$

\begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}
";

pub const MERMAID_TAB: &str = r"# Mermaid

```mermaid
flowchart LR
  A[Lex] --> B[Parse] --> C[Layout]
  C --> D[Paint]
  C --> E[Cache]
```

```mermaid
flowchart TD
  start[Request] --> auth{Authorized?}
  auth -->|yes| serve[Serve page]
  auth -->|no| deny[401]
```
";

pub const GRAPHVIZ_TAB: &str = r#"# Graphviz

```dot
digraph Pipeline {
  rankdir=LR;
  node [shape=box];

  request [label="Request", shape=doublecircle];
  parse [label="{Parse|Validate}", shape=record];
  route [label="Route"];
  cache [label="Cache"];
  reject [label="Reject"];
  render [label="Render"];

  request -> parse [label="source"];
  parse -> route [label="valid"];
  parse -> reject [label="invalid", style=dashed];
  route -> cache;
  route -> render;
  cache -> render [label="hit"];
}
```

```graphviz
graph Runtime {
  node [shape=box];
  Agent -- Broker [label="messages"];
  Broker -- Model;
  Broker -- Tools;
  Tools -- Storage;
}
```
"#;

pub const LIVE_PREFILL: &str =
	"# Live *markdown* — edit me! Math: $x^2 + y^2 = r^2$, chip: #C5FFD6, **bold**, `code`";

pub const PANE_IDS: [&str; 4] = ["pane-md", "pane-math", "pane-mermaid", "pane-graphviz"];

/// Fixed pane height for a viewport: tab bar + gaps + footer + scroll
/// chrome ≈ 8 rows.
pub fn pane_height(viewport: Size) -> u16 {
	viewport.height.saturating_sub(8).max(4)
}

/// Mirrors the editor's text into the preview `<md>` node when it changed.
pub fn sync_preview(ui: &mut Ui, synced: &mut String) {
	let text = ui.values()["src"].as_str().unwrap_or_default().to_owned();
	if text != *synced {
		ui.set_text("preview", text.clone());
		*synced = text;
	}
}
