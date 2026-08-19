//! Rivers of PK — isometric architecture TUI for oh-my-pk.
//!
//! Scan the monorepo, then render it as a navigable olive/beige wireframe
//! city with moving data packets.

mod app;
mod city;
mod iso;
mod model;
mod scan;
mod theme;

use anyhow::{Context, Result};
use app::App;
use clap::Parser;
use crossterm::event::{self, DisableMouseCapture, EnableMouseCapture, Event};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use ratatui::backend::CrosstermBackend;
use ratatui::Terminal;
use std::io::{self, stdout};
use std::path::PathBuf;
use std::time::Duration;

#[derive(Parser, Debug)]
#[command(
    name = "rivers-of-pk",
    about = "Isometric architecture TUI for the oh-my-pk monorepo",
    after_help = "Launch from a real terminal (Windows Terminal / WezTerm). Point --workspace at the repo root."
)]
struct Cli {
    /// Workspace root to scan. Defaults to two parents above this crate, or $CWD.
    #[arg(long, short = 'r')]
    workspace: Option<PathBuf>,

    /// Alias for --workspace.
    #[arg(long, hide = true)]
    root: Option<PathBuf>,

    /// Write the scanned graph JSON and exit (no TUI).
    #[arg(long)]
    dump: Option<PathBuf>,

    /// Scan only; print metrics and exit.
    #[arg(long)]
    scan_only: bool,
}

fn resolve_workspace(cli: &Cli) -> PathBuf {
    if let Some(p) = cli.workspace.as_ref().or(cli.root.as_ref()) {
        return p.clone();
    }
    let crate_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    if let Some(root) = crate_dir.parent().and_then(|p| p.parent()) {
        if root.join("packages/coding-agent").is_dir() && root.join("crates/pi-natives").is_dir() {
            return root.to_path_buf();
        }
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let workspace = resolve_workspace(&cli);
    let graph = scan::scan_workspace(&workspace)
        .with_context(|| format!("scan {}", workspace.display()))?;

    if let Some(path) = cli.dump {
        scan::write_snapshot(&graph, &path)?;
        println!(
            "wrote {} nodes / {} edges → {}",
            graph.nodes.len(),
            graph.edges.len(),
            path.display()
        );
        return Ok(());
    }
    if cli.scan_only {
        let m = &graph.metrics;
        println!("{} v{}", m.project_name, m.version);
        println!(
            "packages={} crates={} tools={} providers={} models={} tests={} ts={} rust={}",
            m.packages,
            m.crates,
            m.tools,
            m.providers,
            m.models,
            m.tests,
            m.ts_files,
            m.rust_files
        );
        println!("nodes={} edges={}", graph.nodes.len(), graph.edges.len());
        return Ok(());
    }

    enable_raw_mode().context("enable raw mode (need a real TTY)")?;
    let mut out = stdout();
    execute!(out, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(out);
    let mut terminal = Terminal::new(backend)?;
    terminal.clear()?;

    let mut app = App::new(graph, workspace.display().to_string());
    let result = run_loop(&mut terminal, &mut app);

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;
    result
}

fn run_loop(
    terminal: &mut Terminal<CrosstermBackend<io::Stdout>>,
    app: &mut App,
) -> Result<()> {
    loop {
        app.tick();
        terminal.draw(|f| app.draw(f))?;
        if event::poll(Duration::from_millis(33))? {
            match event::read()? {
                Event::Key(k) => app.handle(Event::Key(k)),
                other => app.handle(other),
            }
        }
        if app.should_quit {
            break;
        }
    }
    Ok(())
}
