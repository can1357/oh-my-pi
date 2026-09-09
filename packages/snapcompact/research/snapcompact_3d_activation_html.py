# /// script
# requires-python = ">=3.10"
# dependencies = ["numpy", "plotly"]
# ///
"""Build an embeddable interactive 3D activation terrain for snapcompact."""

from __future__ import annotations

import argparse
import base64
import json
from pathlib import Path

import numpy as np
import plotly.graph_objects as go
from plotly.subplots import make_subplots

HERE = Path(__file__).resolve().parent


def downsample(arr: np.ndarray, cols: int) -> np.ndarray:
    if arr.shape[1] <= cols:
        return arr
    edges = np.linspace(0, arr.shape[1], cols + 1).round().astype(int)
    out = np.zeros((arr.shape[0], cols), dtype=np.float32)
    for i in range(cols):
        lo = edges[i]
        hi = max(lo + 1, edges[i + 1])
        out[:, i] = arr[:, lo:hi].mean(axis=1)
    return out


def norm(arr: np.ndarray, q: float = 0.985) -> np.ndarray:
    scale = float(np.quantile(arr, q))
    if scale <= 0:
        scale = 1.0
    return np.clip(arr / scale, 0, 1)


def image_data_uri(path: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def add_surface(
    fig: go.Figure,
    z: np.ndarray,
    row: int,
    col: int,
    name: str,
    colorscale: str,
    showscale: bool = False,
) -> None:
    y = np.arange(z.shape[0])
    x = np.arange(z.shape[1])
    fig.add_trace(
        go.Surface(
            x=x,
            y=y,
            z=z,
            name=name,
            colorscale=colorscale,
            cmin=0,
            cmax=1,
            showscale=showscale,
            lighting={
                "ambient": 0.58,
                "diffuse": 0.72,
                "specular": 0.28,
                "roughness": 0.52,
            },
            contours={
                "z": {
                    "show": True,
                    "usecolormap": True,
                    "highlightcolor": "#fff0a8",
                    "project_z": True,
                },
            },
            hovertemplate="layer %{y}<br>image bin %{x}<br>Δ %{z:.3f}<extra>"
            + name
            + "</extra>",
        ),
        row=row,
        col=col,
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--result-dir", default=str(HERE / "results" / "tensor-heatmap-paddleocr-q7")
    )
    ap.add_argument(
        "--out", default=str(HERE / "results" / "snapcompact-activation-terrain.html")
    )
    ap.add_argument("--bins", type=int, default=150)
    args = ap.parse_args()

    result_dir = Path(args.result_dir)
    summary = json.loads((result_dir / "summary.json").read_text())
    data = np.load(result_dir / "heatmaps.npz")
    answer = norm(downsample(data["answer_binned"], args.bins))
    random = norm(downsample(data["random_binned"], args.bins))
    ratio = norm(downsample(data["ratio_binned"], args.bins), 0.97)

    fig = make_subplots(
        rows=2,
        cols=2,
        specs=[
            [{"type": "surface"}, {"type": "surface"}],
            [{"type": "surface", "colspan": 2}, None],
        ],
        horizontal_spacing=0.02,
        vertical_spacing=0.03,
        subplot_titles=(
            "Gold answer erased",
            "Random equal-size erase",
            "Answer / random residual scar",
        ),
    )
    add_surface(fig, answer, 1, 1, "gold answer mask", "Magma")
    add_surface(fig, random, 1, 2, "random mask", "Viridis")
    add_surface(fig, ratio, 2, 1, "answer/random ratio", "Inferno", True)

    camera = {
        "eye": {"x": 1.65, "y": -1.75, "z": 0.82},
        "center": {"x": 0, "y": 0, "z": -0.08},
    }
    scene_common = {
        "bgcolor": "rgba(0,0,0,0)",
        "camera": camera,
        "xaxis": {
            "title": "image-token bins",
            "gridcolor": "rgba(140,170,180,0.18)",
            "color": "#94a3aa",
            "zeroline": False,
        },
        "yaxis": {
            "title": "decoder layer",
            "gridcolor": "rgba(140,170,180,0.18)",
            "color": "#94a3aa",
            "autorange": "reversed",
            "dtick": 4,
        },
        "zaxis": {
            "title": "Δ hidden",
            "gridcolor": "rgba(140,170,180,0.18)",
            "color": "#94a3aa",
            "range": [0, 1],
        },
        "aspectratio": {"x": 2.6, "y": 0.78, "z": 0.52},
    }
    fig.update_layout(
        template="plotly_dark",
        paper_bgcolor="rgba(0,0,0,0)",
        plot_bgcolor="rgba(0,0,0,0)",
        height=920,
        margin={"l": 0, "r": 0, "t": 58, "b": 0},
        font={"family": "Arial, sans-serif", "color": "#efeede"},
        scene=scene_common,
        scene2=scene_common,
        scene3={**scene_common, "aspectratio": {"x": 3.2, "y": 0.78, "z": 0.58}},
        coloraxis_showscale=False,
    )
    fig.update_annotations(font={"size": 18, "color": "#efeede"})

    q = summary["question"]
    original_uri = image_data_uri(result_dir / "images" / "original.png")
    masked_uri = image_data_uri(result_dir / "images" / "answer-mask.png")
    graph_html = fig.to_html(
        full_html=False,
        include_plotlyjs="cdn",
        config={"displayModeBar": False, "responsive": True},
    )
    html = f"""<!doctype html>
<html>
<head>
<meta charset=\"utf-8\" />
<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
<title>Snapcompact activation terrain</title>
<style>
  :root {{ color-scheme: dark; }}
  html, body {{ margin:0; background:#05070a; color:#efeede; font-family: Arial, sans-serif; }}
  body {{ min-height:100vh; background:
    radial-gradient(circle at 12% 8%, rgba(255,83,62,.20), transparent 34%),
    radial-gradient(circle at 88% 70%, rgba(80,220,255,.18), transparent 36%),
    repeating-linear-gradient(0deg, rgba(255,255,255,.025) 0 1px, transparent 1px 16px), #05070a; }}
  .wrap {{ width: 1680px; height: 1000px; margin: 0 auto; padding: 36px 44px; box-sizing:border-box; overflow:hidden; }}
  .eyebrow {{ color:#ffc241; font-weight:800; letter-spacing:.04em; font-size:20px; }}
  h1 {{ margin:10px 0 4px; font-size:58px; line-height:.98; letter-spacing:-.04em; }}
  .sub {{ color:#9aa4a9; font-size:22px; }}
  .grid {{ display:grid; grid-template-columns: 390px 1fr; gap:28px; margin-top:24px; }}
  .card {{ border:1px solid rgba(160,190,200,.18); background:rgba(13,18,23,.92); border-radius:28px; box-shadow:0 20px 60px rgba(0,0,0,.35); }}
  .left {{ padding:26px; height:790px; box-sizing:border-box; }}
  .left h2 {{ margin:0; font-size:29px; }}
  .muted {{ color:#89979d; }}
  .label {{ margin-top:28px; font-size:14px; font-weight:800; color:#50dcff; letter-spacing:.04em; }}
  .label.red {{ color:#ff533e; }}
  .shot {{ width:100%; height:170px; object-fit:cover; object-position: center 45%; background:#f4f2e6; border-radius:14px; border:3px solid currentColor; image-rendering: pixelated; }}
  .q {{ margin-top:34px; font-size:18px; color:#a4adb2; font-weight:700; }}
  .qtext {{ margin-top:10px; font-size:20px; line-height:1.25; }}
  .answer {{ margin-top:30px; color:#ffc241; font-size:40px; font-weight:900; }}
  .metric {{ margin-top:26px; font-size:20px; line-height:1.55; }}
  .terrain {{ height:790px; padding:10px 14px 0; box-sizing:border-box; }}
  .terrain-title {{ position:absolute; padding:20px 0 0 20px; z-index:2; }}
  .terrain-title b {{ font-size:28px; }}
  .terrain-title span {{ display:block; margin-top:4px; color:#89979d; font-size:16px; }}
  .plot {{ height:760px; margin-top:20px; }}
</style>
</head>
<body>
  <main class=\"wrap\">
    <div class=\"eyebrow\">SNAPCOMPACT WHITEBOX</div>
    <h1>Activation terrain from a missing answer</h1>
    <div class=\"sub\">Actual decoder hidden states: layer × image-token bin × ||original − masked||. Drag the terrain to inspect the residual-stream scar.</div>
    <section class=\"grid\">
      <aside class=\"card left\">
        <h2>visual intervention</h2>
        <div class=\"muted\">same prompt, same bitmap; only answer cells blanked</div>
        <div class=\"label\">ORIGINAL</div>
        <img class=\"shot\" src=\"{original_uri}\" />
        <div class=\"label red\">ANSWER ERASED</div>
        <img class=\"shot\" src=\"{masked_uri}\" />
        <div class=\"q\">question</div>
        <div class=\"qtext\">{q["q"]}</div>
        <div class=\"q\">gold answer</div>
        <div class=\"answer\">{q["answer_text"]}</div>
        <div class=\"metric muted\">{summary["layers"]} layers<br>{summary["image_tokens"]} image tokens<br><b style=\"color:#efeede\">answer/random Δ = {summary["answer_over_random_delta"]:.2f}×</b></div>
      </aside>
      <section class=\"card terrain\">
        <div class=\"terrain-title\"><b>interactive 3D residual terrain</b><span>gold-mask spikes rise where the model reacts to losing the answer glyphs</span></div>
        <div class=\"plot\">{graph_html}</div>
      </section>
    </section>
  </main>
</body>
</html>
"""
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html)
    print(out)


if __name__ == "__main__":
    main()
