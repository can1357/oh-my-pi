#!/usr/bin/env python3
"""Export the paper graph as ONE self-contained HTML file (no external URLs)."""
import argparse
import json
import os
import sqlite3

TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Paper Graph</title>
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #0d1117; color: #c9d1d9;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  #canvas { display: block; cursor: grab; }
  #search { position: fixed; top: 12px; left: 12px; z-index: 2; width: 260px; padding: 7px 10px;
    background: #161b22; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px; outline: none; }
  #search:focus { border-color: #58a6ff; }
  #panel { position: fixed; top: 0; right: 0; width: 320px; height: 100%; box-sizing: border-box;
    padding: 16px; background: #161b22; border-left: 1px solid #30363d; overflow-y: auto;
    transform: translateX(100%); transition: transform .15s ease; z-index: 2; }
  #panel.open { transform: none; }
  #panel h2 { margin: 0 0 8px; font-size: 15px; color: #e6edf3; }
  #panel .meta { color: #8b949e; margin: 4px 0; }
  #panel a { color: #58a6ff; text-decoration: none; word-break: break-all; }
  #panel .close { position: absolute; top: 10px; right: 12px; cursor: pointer; color: #8b949e; }
  #legend { position: fixed; bottom: 12px; left: 12px; z-index: 2; background: #161b22cc;
    border: 1px solid #30363d; border-radius: 6px; padding: 8px 12px; }
  #legend span { display: inline-block; margin-right: 12px; }
  #legend i { display: inline-block; width: 10px; height: 3px; margin-right: 5px; vertical-align: middle; }
</style>
</head>
<body>
<input id="search" type="search" placeholder="Search papers...">
<div id="legend">
  <span><i style="background:#4d9fff"></i>cites</span>
  <span><i style="background:#3fb950"></i>related</span>
  <span><i style="background:#ffa94d"></i>same-topic</span>
</div>
<div id="panel"><span class="close">&times;</span><div id="panel-body"></div></div>
<canvas id="canvas"></canvas>
<script>
const DATA = __DATA__;
const EDGE_COLOR = { "cites": "#4d9fff", "related": "#3fb950", "same-topic": "#ffa94d" };

const canvas = document.getElementById("canvas");
const ctx = canvas.getContext("2d");
let W = 0, H = 0;
function resize() {
  W = window.innerWidth; H = window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + "px"; canvas.style.height = H + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// Build nodes with degree-based radius.
const nodes = DATA.papers.map((p, i) => ({
  ...p, deg: 0,
  x: W / 2 + 220 * Math.cos(2 * Math.PI * i / DATA.papers.length),
  y: H / 2 + 220 * Math.sin(2 * Math.PI * i / DATA.papers.length),
  vx: 0, vy: 0,
}));
const byId = new Map(nodes.map(n => [n.id, n]));
const links = DATA.edges
  .filter(e => byId.has(e.src) && byId.has(e.dst))
  .map(e => ({ a: byId.get(e.src), b: byId.get(e.dst), type: e.type }));
for (const l of links) { l.a.deg++; l.b.deg++; }
for (const n of nodes) n.r = 6 + 3 * Math.sqrt(n.deg);

// View transform (pan/zoom) and interaction state.
let scale = 1, tx = 0, ty = 0;
let alpha = 1, dragNode = null, panning = false, lastX = 0, lastY = 0;
let selected = null, query = "";

function matches(n) {
  if (!query) return true;
  return (n.title + " " + (n.authors || "") + " " + n.id).toLowerCase().includes(query);
}

// Force simulation: pairwise repulsion, spring on edges, gravity to center.
function step() {
  if (alpha < 0.005) return;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x, dy = a.y - b.y;
      let d2 = dx * dx + dy * dy || 1;
      const f = 2600 / d2;
      const d = Math.sqrt(d2);
      dx /= d; dy /= d;
      a.vx += dx * f * alpha; a.vy += dy * f * alpha;
      b.vx -= dx * f * alpha; b.vy -= dy * f * alpha;
    }
  }
  for (const l of links) {
    let dx = l.b.x - l.a.x, dy = l.b.y - l.a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = 0.02 * (d - 120) * alpha;
    dx /= d; dy /= d;
    l.a.vx += dx * f; l.a.vy += dy * f;
    l.b.vx -= dx * f; l.b.vy -= dy * f;
  }
  for (const n of nodes) {
    n.vx += (W / 2 - n.x) * 0.002 * alpha;
    n.vy += (H / 2 - n.y) * 0.002 * alpha;
    if (n !== dragNode) { n.x += n.vx; n.y += n.vy; }
    n.vx *= 0.6; n.vy *= 0.6;
  }
  alpha *= 0.995;
}

function draw() {
  ctx.clearRect(0, 0, W, H);
  ctx.save();
  ctx.translate(tx, ty); ctx.scale(scale, scale);
  for (const l of links) {
    const dim = query && !(matches(l.a) && matches(l.b));
    ctx.globalAlpha = dim ? 0.08 : 0.55;
    ctx.strokeStyle = EDGE_COLOR[l.type] || "#8b949e";
    ctx.lineWidth = 1.4 / scale;
    ctx.beginPath(); ctx.moveTo(l.a.x, l.a.y); ctx.lineTo(l.b.x, l.b.y); ctx.stroke();
  }
  for (const n of nodes) {
    const dim = !matches(n);
    ctx.globalAlpha = dim ? 0.15 : 1;
    ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, 2 * Math.PI);
    ctx.fillStyle = n === selected ? "#e3b341" : "#58a6ff";
    ctx.fill();
    ctx.strokeStyle = "#0d1117"; ctx.lineWidth = 1.5; ctx.stroke();
    if (!dim) {
      ctx.fillStyle = "#c9d1d9";
      ctx.font = (12 / scale) + "px sans-serif";
      const label = n.title.length > 42 ? n.title.slice(0, 40) + "\\u2026" : n.title;
      ctx.fillText(label, n.x + n.r + 4 / scale, n.y + 4 / scale);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function loop() { step(); draw(); requestAnimationFrame(loop); }
loop();

function toWorld(px, py) { return { x: (px - tx) / scale, y: (py - ty) / scale }; }
function nodeAt(px, py) {
  const w = toWorld(px, py);
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    const dx = w.x - n.x, dy = w.y - n.y;
    if (dx * dx + dy * dy <= (n.r + 3) * (n.r + 3)) return n;
  }
  return null;
}

const panel = document.getElementById("panel");
const panelBody = document.getElementById("panel-body");
function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
function showPanel(n) {
  selected = n;
  let doi = n.doi || "";
  if (doi && !doi.startsWith("http")) doi = "https://doi.org/" + doi;
  const link = doi || n.url || "";
  panelBody.innerHTML =
    "<h2>" + esc(n.title) + "</h2>" +
    (n.authors ? "<div class='meta'>" + esc(n.authors) + "</div>" : "") +
    "<div class='meta'>" + esc([n.year, n.venue].filter(Boolean).join(" \\u00b7 ")) + "</div>" +
    "<div class='meta'>id: " + esc(n.id) + " \\u00b7 degree: " + n.deg + "</div>" +
    (link ? "<div><a href='" + esc(link) + "' target='_blank'>" + esc(link) + "</a></div>" : "") +
    (n.abstract ? "<p>" + esc(n.abstract) + "</p>" : "");
  panel.classList.add("open");
}
panel.querySelector(".close").onclick = () => { panel.classList.remove("open"); selected = null; };

canvas.addEventListener("mousedown", e => {
  const n = nodeAt(e.clientX, e.clientY);
  if (n) { dragNode = n; alpha = Math.max(alpha, 0.3); }
  else { panning = true; canvas.style.cursor = "grabbing"; }
  lastX = e.clientX; lastY = e.clientY;
});
window.addEventListener("mousemove", e => {
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  if (dragNode) {
    dragNode.x += dx / scale; dragNode.y += dy / scale;
    alpha = Math.max(alpha, 0.3);
  } else if (panning) { tx += dx; ty += dy; }
});
window.addEventListener("mouseup", e => {
  if (dragNode && Math.abs(e.clientX - lastX) < 3) { /* handled below by click */ }
  dragNode = null; panning = false; canvas.style.cursor = "grab";
});
canvas.addEventListener("click", e => {
  const n = nodeAt(e.clientX, e.clientY);
  if (n) showPanel(n);
});
canvas.addEventListener("wheel", e => {
  e.preventDefault();
  const f = e.deltaY < 0 ? 1.1 : 1 / 1.1;
  const ns = Math.min(8, Math.max(0.15, scale * f));
  // Zoom around the cursor.
  tx = e.clientX - (e.clientX - tx) * (ns / scale);
  ty = e.clientY - (e.clientY - ty) * (ns / scale);
  scale = ns;
}, { passive: false });

document.getElementById("search").addEventListener("input", e => {
  query = e.target.value.trim().toLowerCase();
});
</script>
</body>
</html>
"""


def render(db, out):
    conn = sqlite3.connect(db)
    conn.row_factory = sqlite3.Row
    papers = [
        {
            "id": r["id"], "title": r["title"], "authors": r["authors"],
            "year": r["year"], "venue": r["venue"], "doi": r["doi"],
            "url": r["url"], "abstract": r["abstract"],
        }
        for r in conn.execute(
            "SELECT id, title, authors, year, venue, doi, url, abstract FROM papers"
        )
    ]
    edges = [
        {"src": r["src"], "dst": r["dst"], "type": r["type"]}
        for r in conn.execute("SELECT src, dst, type FROM edges")
    ]
    conn.close()
    # Escape </script>-closing sequences inside the embedded JSON.
    data = json.dumps({"papers": papers, "edges": edges}, ensure_ascii=False)
    data = data.replace("</", "<\\/")
    html = TEMPLATE.replace("__DATA__", data)
    with open(out, "w", encoding="utf-8") as f:
        f.write(html)
    return out


def main():
    ap = argparse.ArgumentParser(description="Export the paper graph to one HTML file.")
    ap.add_argument(
        "--db",
        default=os.environ.get(
            "PAPER_GRAPH_DB", os.path.expanduser("~/.research-harness/papers.db")
        ),
    )
    ap.add_argument("--out", default="paper-graph.html")
    args = ap.parse_args()
    render(args.db, args.out)
    print(json.dumps({"exported": args.out, "format": "html"}))


if __name__ == "__main__":
    main()
