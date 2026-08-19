//! Pseudo-3D isometric wireframe renderer.
//!
//! World units are projected with classic 2:1 isometric (`x-y`, `(x+y)/2 + z`).
//! Faces are painted back-to-front with half-blocks so stacked terraces read
//! as depth rather than a flat box-drawing sketch.

use crate::model::{Box3, Graph, Node};
use crate::theme;
use ratatui::buffer::Buffer;
use ratatui::layout::Rect;
use ratatui::style::{Color, Modifier, Style};
use ratatui::widgets::Widget;

#[derive(Debug, Clone, Copy)]
pub struct Camera {
    pub pan_x: f32,
    pub pan_y: f32,
    pub zoom: f32,
}

impl Default for Camera {
    fn default() -> Self {
        Self {
            pan_x: 2.0,
            pan_y: 0.4,
            zoom: 1.42,
        }
    }
}

impl Camera {
    pub fn clamp(&mut self) {
        self.zoom = self.zoom.clamp(1.15, 5.2);
        self.pan_x = self.pan_x.clamp(-28.0, 28.0);
        self.pan_y = self.pan_y.clamp(-22.0, 22.0);
    }

    pub fn zoom_at(&mut self, factor: f32) {
        self.zoom = (self.zoom * factor).clamp(1.15, 5.2);
    }
}

/// Project world (x, y, z) → screen cells relative to the view origin.
pub fn project(x: f32, y: f32, z: f32, cam: &Camera, origin_x: f32, origin_y: f32) -> (i32, i32) {
    let sx = ((x - y) * cam.zoom) + origin_x + cam.pan_x * cam.zoom;
    let sy = ((x + y) * 0.5 * cam.zoom) - (z * cam.zoom * 0.72) + origin_y + cam.pan_y * cam.zoom;
    (sx.round() as i32, sy.round() as i32)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Face {
    Top,
    Left,
    Right,
}

struct Quad {
    pts: [(i32, i32); 4],
    face: Face,
    depth: f32,
    selected: bool,
    node_idx: usize,
}

pub struct IsoCity<'a> {
    pub graph: &'a Graph,
    pub camera: Camera,
    pub selected: Option<usize>,
    pub hovered: Option<usize>,
    pub inside: Option<usize>,
    pub packets: &'a [Packet],
    pub hover_packet: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct Packet {
    pub edge_idx: usize,
    pub t: f32,
    pub glyph: char,
    pub payload: String,
    pub screen: (i32, i32),
}

impl Packet {
    pub fn advance(&mut self, dt: f32, speed: f32) {
        self.t = (self.t + dt * speed) % 1.0;
    }
}

pub fn edge_world_ends(graph: &Graph, edge_idx: usize) -> Option<((f32, f32, f32), (f32, f32, f32))> {
    let e = graph.edges.get(edge_idx)?;
    let a = graph.node(&e.from)?;
    let b = graph.node(&e.to)?;
    Some((a.r#box.top_center(), b.r#box.top_center()))
}

pub fn packet_world(graph: &Graph, edge_idx: usize, t: f32) -> Option<(f32, f32, f32)> {
    let ((ax, ay, az), (bx, by, bz)) = edge_world_ends(graph, edge_idx)?;
    let lift = (t * std::f32::consts::PI).sin() * 1.4;
    Some((
        ax + (bx - ax) * t,
        ay + (by - ay) * t,
        az + (bz - az) * t + lift,
    ))
}

impl Widget for IsoCity<'_> {
    fn render(self, area: Rect, buf: &mut Buffer) {
        fill(area, buf, theme::BG);

        if area.width < 8 || area.height < 6 {
            return;
        }

        let origin_x = area.x as f32 + area.width as f32 * 0.46;
        let origin_y = area.y as f32 + area.height as f32 * 0.38;

        draw_grid(area, buf, &self.camera, origin_x, origin_y);

        let mut quads: Vec<Quad> = Vec::new();
        for (idx, node) in self.graph.nodes.iter().enumerate() {
            let selected =
                self.selected == Some(idx) || self.hovered == Some(idx) || self.inside == Some(idx);
            push_box_quads(
                &mut quads,
                &node.r#box,
                idx,
                selected,
                &self.camera,
                origin_x,
                origin_y,
            );
            for stack in &node.stacks {
                push_box_quads(
                    &mut quads,
                    stack,
                    idx,
                    selected,
                    &self.camera,
                    origin_x,
                    origin_y,
                );
            }
        }
        quads.sort_by(|a, b| a.depth.partial_cmp(&b.depth).unwrap_or(std::cmp::Ordering::Equal));

        draw_edges(
            area,
            buf,
            self.graph,
            &self.camera,
            origin_x,
            origin_y,
            self.selected,
        );

        for q in &quads {
            fill_quad(area, buf, q);
        }
        for q in &quads {
            stroke_quad(area, buf, q);
        }

        for (idx, node) in self.graph.nodes.iter().enumerate() {
            let selected = self.selected == Some(idx) || self.inside == Some(idx);
            draw_label(
                area,
                buf,
                node,
                &self.camera,
                origin_x,
                origin_y,
                selected,
                self.inside == Some(idx),
            );
            if self.inside == Some(idx) {
                draw_children(area, buf, node, &self.camera, origin_x, origin_y);
            }
        }

        for (i, pkt) in self.packets.iter().enumerate() {
            let (x, y) = pkt.screen;
            if !contains(area, x, y) {
                continue;
            }
            let hot = self.hover_packet == Some(i);
            let style = if hot {
                Style::default()
                    .fg(theme::BG)
                    .bg(theme::PACKET)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::default().fg(theme::PACKET).bg(theme::BG)
            };
            put(buf, x, y, pkt.glyph, style);
        }
    }
}

/// Screen-space top of a node's main prism, for hover/focus tooltips.
pub fn node_label_screen(
    node: &Node,
    cam: &Camera,
    area: Rect,
) -> (i32, i32) {
    let ox = area.x as f32 + area.width as f32 * 0.46;
    let oy = area.y as f32 + area.height as f32 * 0.38;
    let (cx, cy, cz) = node.r#box.top_center();
    project(cx, cy, cz + 0.05, cam, ox, oy)
}

fn push_box_quads(
    out: &mut Vec<Quad>,
    b: &Box3,
    node_idx: usize,
    selected: bool,
    cam: &Camera,
    ox: f32,
    oy: f32,
) {
    let p = |x: f32, y: f32, z: f32| project(x, y, z, cam, ox, oy);
    let x0 = b.x;
    let y0 = b.y;
    let z0 = b.z;
    let x1 = b.x + b.w;
    let y1 = b.y + b.d;
    let z1 = b.z + b.h;

    let c000 = p(x0, y0, z0);
    let c100 = p(x1, y0, z0);
    let c010 = p(x0, y1, z0);
    let c110 = p(x1, y1, z0);
    let c001 = p(x0, y0, z1);
    let c101 = p(x1, y0, z1);
    let c011 = p(x0, y1, z1);
    let c111 = p(x1, y1, z1);

    let depth = x0 + y0 + z0;
    out.push(Quad {
        pts: [c001, c101, c111, c011],
        face: Face::Top,
        depth: depth + 20.0,
        selected,
        node_idx,
    });
    out.push(Quad {
        pts: [c000, c010, c011, c001],
        face: Face::Left,
        depth: depth + 8.0,
        selected,
        node_idx,
    });
    out.push(Quad {
        pts: [c000, c100, c101, c001],
        face: Face::Right,
        depth: depth + 9.0,
        selected,
        node_idx,
    });
    let _ = (c110, c111);
}

fn fill_quad(area: Rect, buf: &mut Buffer, q: &Quad) {
    let (fill, ch) = match (q.face, q.selected) {
        (Face::Top, false) => (theme::FACE_TOP, '▀'),
        (Face::Top, true) => (theme::FACE_TOP_SEL, '▀'),
        (Face::Left, false) => (theme::FACE_LEFT, '▒'),
        (Face::Left, true) => (theme::FACE_LEFT_SEL, '▒'),
        (Face::Right, false) => (theme::FACE_RIGHT, '░'),
        (Face::Right, true) => (theme::FACE_RIGHT_SEL, '░'),
    };
    let xs = q.pts.map(|p| p.0);
    let ys = q.pts.map(|p| p.1);
    let min_x = *xs.iter().min().unwrap_or(&0);
    let max_x = *xs.iter().max().unwrap_or(&0);
    let min_y = *ys.iter().min().unwrap_or(&0);
    let max_y = *ys.iter().max().unwrap_or(&0);
    let style = Style::default().fg(fill).bg(theme::BG);
    for y in min_y..=max_y {
        for x in min_x..=max_x {
            if contains(area, x, y) && point_in_quad(x, y, &q.pts) {
                put(buf, x, y, ch, style);
            }
        }
    }
    let _ = q.node_idx;
}

fn stroke_quad(area: Rect, buf: &mut Buffer, q: &Quad) {
    let color = if q.selected {
        theme::SELECT
    } else {
        theme::WIRE
    };
    let style = Style::default().fg(color).bg(theme::BG);
    for i in 0..4 {
        let a = q.pts[i];
        let b = q.pts[(i + 1) % 4];
        draw_line(area, buf, a.0, a.1, b.0, b.1, style, wire_glyph(a, b));
    }
}

fn wire_glyph(a: (i32, i32), b: (i32, i32)) -> char {
    let dx = (b.0 - a.0).abs();
    let dy = (b.1 - a.1).abs();
    if dx > dy * 2 {
        '─'
    } else if dy > dx * 2 {
        '│'
    } else if (b.0 - a.0).signum() == (b.1 - a.1).signum() {
        '\\'
    } else {
        '/'
    }
}

fn draw_edges(
    area: Rect,
    buf: &mut Buffer,
    graph: &Graph,
    cam: &Camera,
    ox: f32,
    oy: f32,
    selected: Option<usize>,
) {
    for e in &graph.edges {
        let Some(a) = graph.node(&e.from) else { continue };
        let Some(b) = graph.node(&e.to) else { continue };
        let (ax, ay, az) = a.r#box.top_center();
        let (bx, by, bz) = b.r#box.top_center();
        let pa = project(ax, ay, az + 0.15, cam, ox, oy);
        let pb = project(bx, by, bz + 0.15, cam, ox, oy);
        let hot = selected
            .and_then(|i| graph.nodes.get(i))
            .map(|n| n.id == e.from || n.id == e.to)
            .unwrap_or(false);
        let color = match (hot, e.kind) {
            (true, _) => theme::SELECT,
            (false, crate::model::EdgeKind::Feedback) => theme::OLIVE,
            (false, crate::model::EdgeKind::Control) => theme::OLIVE_BRIGHT,
            (false, crate::model::EdgeKind::Data) => theme::WIRE_DIM,
        };
        let style = Style::default().fg(color).bg(theme::BG);
        draw_line(area, buf, pa.0, pa.1, pb.0, pb.1, style, '·');
    }
}

fn draw_label(
    area: Rect,
    buf: &mut Buffer,
    node: &Node,
    cam: &Camera,
    ox: f32,
    oy: f32,
    selected: bool,
    inside: bool,
) {
    let (cx, cy, cz) = node.r#box.top_center();
    let (sx, sy) = project(cx, cy, cz + 0.05, cam, ox, oy);
    let label = if inside {
        format!("[{}] {}", node.code, node.name.to_uppercase())
    } else {
        format!("{} {}", node.code, node.name)
    };
    let style = if selected {
        Style::default()
            .fg(theme::SELECT)
            .bg(theme::BG)
            .add_modifier(Modifier::BOLD)
    } else {
        Style::default().fg(theme::BEIGE).bg(theme::BG)
    };
    put_str(area, buf, sx - (label.len() as i32 / 2), sy, &label, style);
}

fn draw_children(area: Rect, buf: &mut Buffer, node: &Node, cam: &Camera, ox: f32, oy: f32) {
    let b = &node.r#box;
    let cols = 2usize;
    let n = node.children.len().max(1);
    let rows = n.div_ceil(cols);
    let cell_w = (b.w * 0.72) / cols as f32;
    let cell_d = (b.d * 0.72) / rows as f32;
    let origin_x = b.x + b.w * 0.14;
    let origin_y = b.y + b.d * 0.14;
    let mut quads: Vec<Quad> = Vec::new();
    for (i, ch) in node.children.iter().enumerate() {
        let col = (i % cols) as f32;
        let row = (i / cols) as f32;
        let inner = Box3::new(
            origin_x + col * cell_w + 0.12,
            origin_y + row * cell_d + 0.12,
            b.z + b.h * 0.55,
            (cell_w - 0.28).max(0.7),
            (cell_d - 0.28).max(0.6),
            0.7 + (ch.count.min(8) as f32) * 0.08,
        );
        push_box_quads(&mut quads, &inner, 0, true, cam, ox, oy);
        let (sx, sy) = project(
            inner.x + inner.w * 0.5,
            inner.y + inner.d * 0.5,
            inner.z + inner.h + 0.05,
            cam,
            ox,
            oy,
        );
        put_str(
            area,
            buf,
            sx - (ch.code.len() as i32 / 2),
            sy,
            &ch.code,
            Style::default()
                .fg(theme::SELECT)
                .bg(theme::BG)
                .add_modifier(Modifier::BOLD),
        );
    }
    quads.sort_by(|a, b| a.depth.partial_cmp(&b.depth).unwrap_or(std::cmp::Ordering::Equal));
    for q in &quads {
        fill_quad(area, buf, q);
    }
    for q in &quads {
        stroke_quad(area, buf, q);
    }
}

fn draw_grid(area: Rect, buf: &mut Buffer, cam: &Camera, ox: f32, oy: f32) {
    let style = Style::default().fg(Color::Rgb(24, 24, 18)).bg(theme::BG);
    for i in (-12..=14).step_by(2) {
        let a = project(i as f32 * 2.5, -14.0, 0.0, cam, ox, oy);
        let b = project(i as f32 * 2.5, 14.0, 0.0, cam, ox, oy);
        draw_line(area, buf, a.0, a.1, b.0, b.1, style, '·');
        let c = project(-14.0, i as f32 * 2.5, 0.0, cam, ox, oy);
        let d = project(16.0, i as f32 * 2.5, 0.0, cam, ox, oy);
        draw_line(area, buf, c.0, c.1, d.0, d.1, style, '·');
    }
}

fn draw_line(area: Rect, buf: &mut Buffer, x0: i32, y0: i32, x1: i32, y1: i32, style: Style, ch: char) {
    let mut x = x0;
    let mut y = y0;
    let dx = (x1 - x0).abs();
    let sx = if x0 < x1 { 1 } else { -1 };
    let dy = -(y1 - y0).abs();
    let sy = if y0 < y1 { 1 } else { -1 };
    let mut err = dx + dy;
    loop {
        if contains(area, x, y) {
            put(buf, x, y, ch, style);
        }
        if x == x1 && y == y1 {
            break;
        }
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x += sx;
        }
        if e2 <= dx {
            err += dx;
            y += sy;
        }
    }
}

fn point_in_quad(x: i32, y: i32, pts: &[(i32, i32); 4]) -> bool {
    point_in_tri(x, y, pts[0], pts[1], pts[2]) || point_in_tri(x, y, pts[0], pts[2], pts[3])
}

fn point_in_tri(px: i32, py: i32, a: (i32, i32), b: (i32, i32), c: (i32, i32)) -> bool {
    let s = (a.0 - c.0) * (py - c.1) - (a.1 - c.1) * (px - c.0);
    let t = (b.0 - a.0) * (py - a.1) - (b.1 - a.1) * (px - a.0);
    if (s < 0) != (t < 0) && s != 0 && t != 0 {
        return false;
    }
    let d = (c.0 - b.0) * (py - b.1) - (c.1 - b.1) * (px - b.0);
    d == 0 || (d < 0) == (s + t <= 0)
}

fn fill(area: Rect, buf: &mut Buffer, color: Color) {
    let style = Style::default().bg(color).fg(color);
    for y in area.y..area.y + area.height {
        for x in area.x..area.x + area.width {
            if let Some(cell) = buf.cell_mut((x, y)) {
                cell.set_style(style);
                cell.set_char(' ');
            }
        }
    }
}

fn contains(area: Rect, x: i32, y: i32) -> bool {
    x >= area.x as i32
        && y >= area.y as i32
        && x < (area.x + area.width) as i32
        && y < (area.y + area.height) as i32
}

fn put(buf: &mut Buffer, x: i32, y: i32, ch: char, style: Style) {
    if x < 0 || y < 0 {
        return;
    }
    if let Some(cell) = buf.cell_mut((x as u16, y as u16)) {
        cell.set_char(ch);
        cell.set_style(style);
    }
}

fn put_str(area: Rect, buf: &mut Buffer, x: i32, y: i32, text: &str, style: Style) {
    for (i, ch) in text.chars().enumerate() {
        let xx = x + i as i32;
        if contains(area, xx, y) {
            put(buf, xx, y, ch, style);
        }
    }
}

/// Hit-test a screen cell against node top faces. Returns nearest node index.
pub fn hit_node(graph: &Graph, cam: &Camera, area: Rect, mx: u16, my: u16) -> Option<usize> {
    let ox = area.x as f32 + area.width as f32 * 0.46;
    let oy = area.y as f32 + area.height as f32 * 0.38;
    let mut best: Option<(f32, usize)> = None;
    for (idx, node) in graph.nodes.iter().enumerate() {
        let (cx, cy, cz) = node.r#box.top_center();
        let (sx, sy) = project(cx, cy, cz, cam, ox, oy);
        let dx = sx as f32 - mx as f32;
        let dy = sy as f32 - my as f32;
        let dist = dx * dx + dy * dy;
        let radius = (node.r#box.w + node.r#box.d) * cam.zoom * 0.7;
        if dist.sqrt() <= radius.max(3.0) {
            match best {
                Some((bd, _)) if dist >= bd => {}
                _ => best = Some((dist, idx)),
            }
        }
    }
    best.map(|(_, i)| i)
}

pub fn packet_screen(
    graph: &Graph,
    cam: &Camera,
    area: Rect,
    edge_idx: usize,
    t: f32,
) -> Option<(i32, i32)> {
    let (x, y, z) = packet_world(graph, edge_idx, t)?;
    let ox = area.x as f32 + area.width as f32 * 0.46;
    let oy = area.y as f32 + area.height as f32 * 0.38;
    Some(project(x, y, z, cam, ox, oy))
}
