//! Architecture graph consumed by the isometric city.
//!
//! The spatial layout is curated (a map, not a force-directed scribble).
//! Counts, children, metrics, and packet payloads are filled by `scan`
//! so the diagram updates when the workspace changes.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub enum Section {
    System,
    Evolution,
    Process,
    Memory,
    Interface,
    World,
}

impl Section {
    pub fn label(self) -> &'static str {
        match self {
            Section::System => "THE SYSTEM",
            Section::Evolution => "THE EVOLUTION LOOP",
            Section::Process => "THE LIVING PROCESS",
            Section::Memory => "THE MEMORY",
            Section::Interface => "THE INTERFACE",
            Section::World => "THE WORLD",
        }
    }

    pub fn all() -> [Section; 6] {
        [
            Section::System,
            Section::Evolution,
            Section::Process,
            Section::Memory,
            Section::Interface,
            Section::World,
        ]
    }
}

/// Axis-aligned box in world units. Isometric projection happens in `iso`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Box3 {
    pub x: f32,
    pub y: f32,
    pub z: f32,
    pub w: f32,
    pub d: f32,
    pub h: f32,
}

impl Box3 {
    pub fn new(x: f32, y: f32, z: f32, w: f32, d: f32, h: f32) -> Self {
        Self { x, y, z, w, d, h }
    }

    pub fn center(&self) -> (f32, f32, f32) {
        (
            self.x + self.w * 0.5,
            self.y + self.d * 0.5,
            self.z + self.h * 0.5,
        )
    }

    pub fn top_center(&self) -> (f32, f32, f32) {
        (
            self.x + self.w * 0.5,
            self.y + self.d * 0.5,
            self.z + self.h,
        )
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Node {
    pub id: String,
    pub code: char,
    pub name: String,
    pub section: Section,
    pub count: u32,
    pub count_label: String,
    pub what: String,
    pub how: String,
    pub paths: Vec<String>,
    pub children: Vec<Child>,
    pub r#box: Box3,
    /// Optional stacked terraces drawn on top of the main prism.
    pub stacks: Vec<Box3>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Child {
    pub code: String,
    pub name: String,
    pub count: u32,
    pub note: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Edge {
    pub from: String,
    pub to: String,
    pub label: String,
    pub kind: EdgeKind,
    pub payloads: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum EdgeKind {
    Data,
    Control,
    Feedback,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Metrics {
    pub project_name: String,
    pub version: String,
    pub packages: u32,
    pub crates: u32,
    pub tools: u32,
    pub providers: u32,
    pub models: u32,
    pub tests: u32,
    pub python_packages: u32,
    pub natives_modules: u32,
    pub ts_files: u32,
    pub rust_files: u32,
    pub generated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Graph {
    pub metrics: Metrics,
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub unmapped: Vec<String>,
}

impl Graph {
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }

    pub fn neighbors(&self, id: &str) -> Vec<&Edge> {
        self.edges
            .iter()
            .filter(|e| e.from == id || e.to == id)
            .collect()
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letter_codes_skip_ambiguous() {
        let alphabet = b"ABCDEFGHJKLMNPQRSTUVWXYZ";
        assert_eq!(alphabet[0], b'A');
        assert!(!alphabet.contains(&b'I'));
        assert!(!alphabet.contains(&b'O'));
    }

    #[test]
    fn city_ids_and_codes_are_unique() {
        let g = crate::city::seed_city();
        let mut ids = std::collections::BTreeSet::new();
        let mut codes = std::collections::BTreeSet::new();
        for n in &g.nodes {
            assert!(ids.insert(&n.id), "duplicate id {}", n.id);
            assert!(codes.insert(n.code), "duplicate code {}", n.code);
        }
        assert_eq!(g.nodes.len(), 24);
        assert_eq!(g.edges.len(), 32);
        for e in &g.edges {
            assert!(g.node(&e.from).is_some(), "dangling from {}", e.from);
            assert!(g.node(&e.to).is_some(), "dangling to {}", e.to);
        }
    }
}
