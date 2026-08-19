use ratatui::backend::TestBackend;
use ratatui::Terminal;
use rivers_of_pk::city::seed_city;
use rivers_of_pk::iso::{packet_world, Camera, IsoCity, Packet};
use rivers_of_pk::scan::scan_workspace;
use std::collections::HashSet;
use std::path::PathBuf;

fn workspace() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|p| p.parent())
        .expect("repo root")
        .to_path_buf()
}

#[test]
fn city_codes_and_edges_are_well_formed() {
    let g = seed_city();
    assert!(g.nodes.len() >= 20);
    let mut codes = HashSet::new();
    let ids: HashSet<_> = g.nodes.iter().map(|n| n.id.as_str()).collect();
    for n in &g.nodes {
        assert!(n.code.is_ascii_uppercase(), "code {}", n.code);
        assert!(codes.insert(n.code), "duplicate code {}", n.code);
        assert!(!n.what.is_empty(), "{}", n.id);
        assert!(!n.how.is_empty(), "{}", n.id);
        assert!(n.r#box.w > 0.0 && n.r#box.d > 0.0 && n.r#box.h > 0.0);
    }
    assert!(!g.edges.is_empty());
    for e in &g.edges {
        assert!(ids.contains(e.from.as_str()), "missing from {}", e.from);
        assert!(ids.contains(e.to.as_str()), "missing to {}", e.to);
        assert_ne!(e.from, e.to);
    }
}

#[test]
fn scan_fills_live_counts() {
    let g = scan_workspace(&workspace()).expect("scan");
    assert!(g.metrics.packages >= 10, "packages={}", g.metrics.packages);
    assert!(g.metrics.crates >= 3, "crates={}", g.metrics.crates);
    assert!(g.metrics.tools >= 20, "tools={}", g.metrics.tools);
    assert!(g.metrics.tests > 50, "tests={}", g.metrics.tests);
    let loop_node = g.node("loop").expect("loop node");
    assert!(loop_node.count > 0);
    assert!(loop_node.what.contains("turn") || loop_node.how.contains("agent-loop"));
    let edge = g
        .edges
        .iter()
        .find(|e| e.from == "session" && e.to == "loop")
        .expect("session → loop edge");
    assert!(
        edge.payloads.iter().any(|p| p.contains("prompt")),
        "{:?}",
        edge.payloads
    );
}

#[test]
fn packets_travel_between_endpoints() {
    let g = seed_city();
    let start = packet_world(&g, 0, 0.0).unwrap();
    let mid = packet_world(&g, 0, 0.5).unwrap();
    let end = packet_world(&g, 0, 1.0).unwrap();
    assert!((start.0 - end.0).abs() + (start.1 - end.1).abs() > 1.0);
    let mid_x = (start.0 + end.0) * 0.5;
    assert!((mid.0 - mid_x).abs() < 0.01);
}

#[test]
fn isometric_frame_paints_letter_codes() {
    let g = scan_workspace(&workspace()).expect("scan");
    let packets = vec![Packet {
        edge_idx: 0,
        t: 0.4,
        glyph: '•',
        payload: "probe".into(),
        screen: (0, 0),
    }];
    let backend = TestBackend::new(160, 48);
    let mut term = Terminal::new(backend).unwrap();
    term.draw(|f| {
        f.render_widget(
            IsoCity {
                graph: &g,
                camera: Camera::default(),
                selected: Some(0),
                hovered: None,
                inside: None,
                packets: &packets,
                hover_packet: None,
            },
            f.area(),
        );
    })
    .unwrap();
    let buf = term.backend().buffer();
    let mut painted = String::new();
    for y in 0..buf.area.height {
        for x in 0..buf.area.width {
            painted.push_str(buf[(x, y)].symbol());
        }
        painted.push('\n');
    }
    let found: Vec<char> = g
        .nodes
        .iter()
        .map(|n| n.code)
        .filter(|c| painted.contains(*c))
        .collect();
    assert!(
        found.len() >= 8,
        "only saw codes {found:?} in frame:\n{painted}"
    );
}
