//! Walk the workspace and fill live counts into the curated city graph.
//!
//! The spatial map is authored in `city.rs`. This module only measures what
//! is actually on disk so the badges, metrics, and packet payloads stay true
//! when packages, tools, or providers change.

use crate::city::seed_city;
use crate::model::{Box3, Edge, EdgeKind, Graph, Metrics, Node, Section};
use anyhow::Result;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    ".git",
    ".ompk",
    "vendor",
    "crates/vendor",
    "crates/brush-core-vendored",
    "crates/brush-builtins-vendored",
    "__pycache__",
    ".ruff_cache",
    ".pytest_cache",
];

pub fn scan_workspace(root: &Path) -> Result<Graph> {
    let mut graph = seed_city();
    let counts = measure(root)?;
    apply(&mut graph, &counts);
    attach_unmapped(root, &mut graph);
    Ok(graph)
}

struct Counts {
    packages: u32,
    crates: u32,
    tools: u32,
    providers: u32,
    catalog_providers: u32,
    models: u32,
    tests: u32,
    python_packages: u32,
    natives_modules: u32,
    ts_files: u32,
    rust_files: u32,
    tui_files: u32,
    mcp_files: u32,
    version: String,
    extras: std::collections::BTreeMap<String, u32>,
}

fn measure(root: &Path) -> Result<Counts> {
    let mut extras = std::collections::BTreeMap::new();

    let packages = count_dirs(root.join("packages"));
    let crates = count_dirs(root.join("crates"));
    let python_packages = count_dirs(root.join("python"));
    let tools = count_tool_modules(&root.join("packages/coding-agent/src/tools"));
    let providers = count_files(root.join("packages/ai/src/providers"), &["ts", "js"]);
    let catalog_providers = count_catalog_providers(root);
    let models = count_catalog_models(root);
    let natives_modules = count_rust_mods(&root.join("crates/pi-natives/src"));
    let tui_files = count_files(root.join("packages/tui/src"), &["ts"]);
    let mcp_files = count_files(root.join("packages/coding-agent/src/mcp"), &["ts"]);
    let tests = count_test_files(root);
    let ts_files = count_files(root.join("packages"), &["ts"]);
    let rust_files = count_files(root.join("crates"), &["rs"]);
    let version = read_version(root);

    extras.insert("tools".into(), tools);
    extras.insert("providers".into(), providers);
    extras.insert("catalog_providers".into(), catalog_providers);
    extras.insert("mcp".into(), mcp_files);
    extras.insert("ts".into(), ts_files);
    extras.insert("tui".into(), tui_files);
    extras.insert("caps".into(), 10);
    extras.insert("packages".into(), packages);
    extras.insert("crates".into(), crates);

    Ok(Counts {
        packages,
        crates,
        tools,
        providers,
        catalog_providers,
        models,
        tests,
        python_packages,
        natives_modules,
        ts_files,
        rust_files,
        tui_files,
        mcp_files,
        version,
        extras,
    })
}

fn apply(graph: &mut Graph, counts: &Counts) {
    graph.metrics = Metrics {
        project_name: read_project_name(),
        version: counts.version.clone(),
        packages: counts.packages,
        crates: counts.crates,
        tools: counts.tools,
        providers: counts.providers,
        models: counts.models,
        tests: counts.tests,
        python_packages: counts.python_packages,
        natives_modules: counts.natives_modules,
        ts_files: counts.ts_files,
        rust_files: counts.rust_files,
        generated_at: chrono_now(),
    };

    for node in &mut graph.nodes {
        node.what = expand(&node.what, &graph.metrics, &counts.extras);
        node.how = expand(&node.how, &graph.metrics, &counts.extras);
        for child in &mut node.children {
            child.note = expand(&child.note, &graph.metrics, &counts.extras);
        }

        let badge = match node.id.as_str() {
            "providers" => counts.providers,
            "mcp" => counts.mcp_files,
            "workspace" => counts.ts_files,
            "collab-world" => 2,
            "session" => 1,
            "loop" => 1,
            "stream" => counts.providers,
            "tools" => counts.tools,
            "host" => 1,
            "core" => 1,
            "ai" => counts.providers,
            "catalog" => counts.catalog_providers.max(1),
            "natives" => counts.natives_modules,
            "journal" => 1,
            "compact" => 3,
            "memory" => 3,
            "urls" => 14,
            "task" => 1,
            "discovery" => 10,
            "skills" => 2,
            "tui" => counts.tui_files,
            "modes" => 4,
            "cli" => 1,
            "python" => counts.python_packages,
            _ => 0,
        };
        node.count = badge;
        node.count_label = badge.to_string();

        for child in &mut node.children {
            if child.count == 0 {
                if child.note.contains("{tools}") {
                    child.count = counts.tools;
                } else if child.note.contains("{providers}") {
                    child.count = counts.providers;
                } else if child.note.contains("{catalog_providers}") {
                    child.count = counts.catalog_providers;
                } else if child.note.contains("{mcp}") {
                    child.count = counts.mcp_files;
                } else if child.note.contains("{ts}") {
                    child.count = counts.ts_files;
                } else if child.note.contains("{tui}") {
                    child.count = counts.tui_files;
                } else if child.note.contains("{caps}") {
                    child.count = 10;
                }
            }
        }
    }

    for edge in &mut graph.edges {
        edge.payloads = match (edge.from.as_str(), edge.to.as_str()) {
            ("providers", "stream") => vec![
                r#"event: content_block_delta  data: {"type":"text_delta","text":"…"}"#.into(),
                r#"thinking { type: "enabled", budget_tokens: 10000 }"#.into(),
                format!("registerBuiltins()  {} lazy provider adapters", counts.providers),
            ],
            ("catalog", "stream") | ("catalog", "ai") => vec![
                format!("getBundledModel()  {} entries in models.json", counts.models),
                r#"Model { provider: "anthropic", id: "claude-opus-4-6", api: "anthropic-messages" }"#.into(),
            ],
            ("stream", "loop") => vec![
                r#"AssistantMessage { content: [Text, ToolCall], stopReason: "toolUse" }"#.into(),
                r#"usage { inputTokens, outputTokens, cacheRead, cacheWrite }"#.into(),
            ],
            ("loop", "tools") => vec![
                r#"executeToolCalls([{ name: "read", args: { path } }])"#.into(),
                r#"toolChoice: { type: "required" }  // SoftToolRequirement"#.into(),
            ],
            ("tools", "natives") => vec![
                r#"natives.grep({ pattern, globs, path })"#.into(),
                r#"natives.glob({ paths: ["packages/**/*.ts"] })"#.into(),
                r#"natives.pty.spawn({ cmd, cwd })"#.into(),
            ],
            ("natives", "tools") => vec![
                r#"{ matches: [{ path, line, text }], truncated: false }"#.into(),
                r#"{ exitCode: 0, stdout, stderr }"#.into(),
            ],
            ("tools", "workspace") => vec![
                r#"read({ path: "packages/agent/src/agent-loop.ts:700-1107" })"#.into(),
                r#"hashline.apply({ file, hunks: [{ tag, swap }] })"#.into(),
            ],
            ("tools", "mcp") => vec![
                r#"MCPManager.call("mcp__server__tool", args)"#.into(),
            ],
            ("mcp", "tools") => vec![
                r#"ToolResult { content: [{ type: "text", text }] }"#.into(),
            ],
            ("tools", "urls") => vec![
                r#"InternalUrlRouter.resolve("skill://codebase-design")"#.into(),
                r#"read("agent://<id>/output")"#.into(),
            ],
            ("urls", "tools") => vec![
                r#"{ scheme: "skill", path, selector }"#.into(),
            ],
            ("session", "loop") => vec![
                r#"Agent.prompt({ role: "user", content: text, images? })"#.into(),
                r#"steer(queue)  // mid-run, not a new loop"#.into(),
            ],
            ("session", "stream") => vec![
                r#"systemPrompt = buildSystemPrompt(tools, AGENTS.md, skills)"#.into(),
            ],
            ("host", "session") => vec![
                r#"createAgentSession({ cwd, settings, sessionManager, tools })"#.into(),
            ],
            ("host", "cli") => vec![
                r#"runRootCommand(argv)  // 10s startup watchdog"#.into(),
            ],
            ("cli", "modes") => vec![
                r#"handoff: interactive | print | acp | rpc"#.into(),
            ],
            ("modes", "tui") => vec![
                r#"Component.render(width) → append-only scrollback"#.into(),
            ],
            ("tui", "session") => vec![
                r#"AgentSessionEvent { type: "tool_execution_start", name, args }"#.into(),
                r#"{ type: "message_update", delta }"#.into(),
            ],
            ("loop", "journal") => vec![
                r#"SessionEntry { id, parentId, type: "message", message }"#.into(),
                r#"{ type: "compaction", summary }"#.into(),
            ],
            ("journal", "compact") => vec![
                r#"tokens > contextWindow * 0.8  →  compact()"#.into(),
            ],
            ("compact", "loop") => vec![
                r#"COMPACTION_RECOVERY_BAND = 0.8  headroom restored"#.into(),
            ],
            ("memory", "session") => vec![
                r#"recall({ query }) → MemoryHit[]"#.into(),
            ],
            ("session", "memory") => vec![
                r#"retain({ kind, text })  // hindsight | mnemopi | local"#.into(),
            ],
            ("loop", "task") => vec![
                r#"task({ tasks: [{ assignment, role }] })"#.into(),
                r#"deliverIrcMessage(channel, body)"#.into(),
            ],
            ("task", "session") => vec![
                r#"child = createAgentSession({ worktree, iso, parent })"#.into(),
            ],
            ("discovery", "host") => vec![
                r#"loadCapability()  cwd → repo → home  // 10 providers"#.into(),
            ],
            ("skills", "session") => vec![
                r#"<skill name="codebase-design">…</skill>  + TTSR reminder"#.into(),
            ],
            ("collab-world", "session") => vec![
                r#"encrypted frame { type: "entry", entry: SessionEntry }"#.into(),
            ],
            ("python", "modes") => vec![
                r#"omp --mode rpc  // robomp WorkerPool per-issue worktree"#.into(),
            ],
            ("ai", "stream") => vec![
                r#"streamDispatch(model) → switch (model.api)"#.into(),
            ],
            ("core", "loop") => vec![
                r#"runLoopBody(ctx)  // outer follow-up, inner tool loop"#.into(),
            ],
            _ => vec![edge.label.clone()],
        };
    }
}

/// Packages / crates / python dirs that no curated box claims.
/// Each one becomes a live System box so a new module shows up on the next launch.
fn attach_unmapped(root: &Path, graph: &mut Graph) {
    let claimed = claimed_prefixes(graph);
    let mut found = Vec::new();
    for (kind, dir) in [
        ("packages", root.join("packages")),
        ("crates", root.join("crates")),
        ("python", root.join("python")),
    ] {
        found.extend(list_child_dirs(&dir).into_iter().map(|name| (kind, name)));
    }

    let mut extras: Vec<(String, String, String)> = Vec::new();
    for (kind, name) in found {
        let prefix = format!("{kind}/{name}");
        if claimed.iter().any(|c| {
            c == &prefix
                || prefix.starts_with(&format!("{c}/"))
                || c.starts_with(&format!("{prefix}/"))
        }) {
            continue;
        }
        if SKIP_UNMAPPED.iter().any(|s| *s == name) {
            continue;
        }
        extras.push((kind.to_string(), name, prefix));
    }
    graph.unmapped = extras.iter().map(|(_, _, p)| p.clone()).collect();
    if extras.is_empty() {
        return;
    }

    let mut used: std::collections::BTreeSet<char> =
        graph.nodes.iter().map(|n| n.code).collect();
    let code = next_code(&mut used);
    let children: Vec<crate::model::Child> = extras
        .iter()
        .enumerate()
        .map(|(i, (kind, name, prefix))| {
            let files = count_files(root.join(prefix), &["ts", "rs", "py"]);
            crate::model::Child {
                code: format!("Z{}", i + 1),
                name: name.clone(),
                count: files,
                note: format!("{kind}/{name}"),
            }
        })
        .collect();
    let total: u32 = children.iter().map(|c| c.count).sum();
    let names: Vec<&str> = extras.iter().map(|(_, n, _)| n.as_str()).collect();
    graph.nodes.push(Node {
        id: "unmapped".into(),
        code,
        name: "Unmapped".into(),
        section: Section::System,
        count: extras.len() as u32,
        count_label: extras.len().to_string(),
        what: format!(
            "{} workspace dirs have no curated box yet: {}. Enter this structure to see each one. Promote a name into city.rs when it becomes a first-class seam.",
            extras.len(),
            names.join(", ")
        ),
        how: "scan.rs::attach_unmapped walks packages/, crates/, python/ and diffs against paths claimed in city.rs.".into(),
        paths: extras.iter().map(|(_, _, p)| p.clone()).collect(),
        children,
        r#box: Box3::new(20.0, 6.0, 0.0, 4.2, 3.6, 2.4),
        stacks: vec![Box3::new(20.6, 6.5, 2.4, 1.4, 1.2, 0.8)],
    });
    graph.edges.push(Edge {
        from: "host".into(),
        to: "unmapped".into(),
        label: "unmapped".into(),
        kind: EdgeKind::Control,
        payloads: vec![format!(
            "attach_unmapped()  {} dirs / {} files",
            extras.len(),
            total
        )],
    });
}

const SKIP_UNMAPPED: &[&str] = &[
    "node_modules",
    "vendor",
    "target",
    "dist",
    "brush-core-vendored",
    "brush-builtins-vendored",
];

fn claimed_prefixes(graph: &Graph) -> Vec<String> {
    let mut out = Vec::new();
    for node in &graph.nodes {
        for p in &node.paths {
            let cleaned = p.trim_end_matches('/');
            let parts: Vec<&str> = cleaned.split('/').collect();
            if parts.len() >= 2 && matches!(parts[0], "packages" | "crates" | "python") {
                out.push(format!("{}/{}", parts[0], parts[1]));
            }
        }
    }
    out.sort();
    out.dedup();
    out
}

fn list_child_dirs(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| !n.starts_with('.') && n != "node_modules")
        .collect();
    names.sort();
    names
}

fn next_code(used: &mut std::collections::BTreeSet<char>) -> char {
    for c in ('A'..='Z').filter(|c| *c != 'I' && *c != 'O') {
        if used.insert(c) {
            return c;
        }
    }
    for c in '2'..='9' {
        if used.insert(c) {
            return c;
        }
    }
    '?'
}

fn expand(text: &str, m: &Metrics, extras: &std::collections::BTreeMap<String, u32>) -> String {
    let mut out = text.to_string();
    out = out.replace("{packages}", &m.packages.to_string());
    out = out.replace("{crates}", &m.crates.to_string());
    out = out.replace("{models}", &m.models.to_string());
    out = out.replace("{tests}", &m.tests.to_string());
    for (k, v) in extras {
        out = out.replace(&format!("{{{k}}}"), &v.to_string());
    }
    out
}

fn read_project_name() -> String {
    "oh-my-pk".into()
}

fn read_version(root: &Path) -> String {
    let pkg = root.join("packages/coding-agent/package.json");
    if let Some(v) = read_json(pkg).and_then(|j| {
        j.get("version")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
    }) {
        return v;
    }
    "16.4.1".into()
}

fn read_json(path: PathBuf) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn chrono_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("unix:{secs}")
}

fn should_skip(path: &Path) -> bool {
    path.components().any(|c| {
        let s = c.as_os_str().to_string_lossy();
        SKIP_DIRS.iter().any(|d| s == *d)
    })
}

fn count_files(dir: PathBuf, exts: &[&str]) -> u32 {
    if !dir.exists() {
        return 0;
    }
    WalkDir::new(dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .filter(|e| !should_skip(e.path()))
        .filter(|e| {
            e.path()
                .extension()
                .and_then(|x| x.to_str())
                .map(|ext| exts.iter().any(|want| *want == ext))
                .unwrap_or(false)
        })
        .count() as u32
}

fn count_dirs(dir: PathBuf) -> u32 {
    if !dir.exists() {
        return 0;
    }
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| e.path().is_dir())
                .filter(|e| {
                    let name = e.file_name().to_string_lossy().to_string();
                    !name.starts_with('.') && name != "node_modules"
                })
                .count() as u32
        })
        .unwrap_or(0)
}

fn count_tool_modules(dir: &Path) -> u32 {
    if !dir.exists() {
        return 0;
    }
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| {
                    let p = e.path();
                    if p.is_dir() {
                        return !matches!(
                            e.file_name().to_string_lossy().as_ref(),
                            "__tests__" | "puppeteer"
                        );
                    }
                    p.extension().and_then(|x| x.to_str()) == Some("ts")
                        && !e.file_name().to_string_lossy().ends_with(".test.ts")
                        && !e.file_name().to_string_lossy().starts_with("tool-")
                        && e.file_name().to_string_lossy() != "index.ts"
                })
                .count() as u32
        })
        .unwrap_or(0)
}

fn count_rust_mods(dir: &Path) -> u32 {
    if !dir.exists() {
        return 0;
    }
    fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter(|e| {
                    let p = e.path();
                    p.is_dir()
                        || (p.extension().and_then(|x| x.to_str()) == Some("rs")
                            && e.file_name().to_string_lossy() != "lib.rs")
                })
                .count() as u32
        })
        .unwrap_or(0)
}

fn count_catalog_providers(root: &Path) -> u32 {
    let dir = root.join("packages/catalog/src");
    if !dir.exists() {
        return 0;
    }
    // models.ts / identity / providers typically live as modules.
    count_files(dir.join("providers"), &["ts"]).max(count_dirs(dir.join("providers")))
}

fn count_catalog_models(root: &Path) -> u32 {
    let json = root.join("packages/catalog/src/models.json");
    if let Some(v) = read_json(json) {
        if let Some(arr) = v.as_array() {
            return arr.len() as u32;
        }
        if let Some(obj) = v.as_object() {
            if let Some(models) = obj.get("models").and_then(|m| m.as_array()) {
                return models.len() as u32;
            }
            return obj.len() as u32;
        }
    }
    0
}

fn count_test_files(root: &Path) -> u32 {
    let mut n = 0u32;
    for dir in [
        root.join("packages"),
        root.join("crates"),
        root.join("python"),
    ] {
        if !dir.exists() {
            continue;
        }
        n += WalkDir::new(dir)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().is_file())
            .filter(|e| !should_skip(e.path()))
            .filter(|e| {
                let name = e.file_name().to_string_lossy();
                name.ends_with(".test.ts")
                    || name.ends_with(".spec.ts")
                    || name.ends_with("_test.rs")
                    || name.starts_with("test_") && name.ends_with(".py")
            })
            .count() as u32;
    }
    n
}

pub fn write_snapshot(graph: &Graph, path: &Path) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(path, serde_json::to_string_pretty(graph)?)?;
    Ok(())
}
