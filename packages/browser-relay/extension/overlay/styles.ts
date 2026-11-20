/**
 * The overlay's stylesheet, adopted by its closed shadow root. Colors are fixed (omp's dark tokens) on every site so
 * the overlay never reads as part of the page.
 */
export const OVERLAY_CSS = `
:host{all:initial!important;display:contents!important}
*,*::before,*::after{box-sizing:border-box}
[hidden]{display:none!important}

.stage,.picker{
	--font:"Inter var","Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
	--mono:ui-monospace,"SF Mono","JetBrains Mono","Cascadia Mono",Menlo,Consolas,monospace;
	--glass:rgba(10,10,11,.92);--line:rgba(255,255,255,.14);
	--ink:#ededef;--muted:#a0a0a8;--faint:#6c6c74;--cyan:#5ad8e6;--pink:#ed4abf;
	--float:0 10px 28px rgba(0,0,0,.22),0 2px 6px rgba(0,0,0,.12);
	--ease:cubic-bezier(.16,1,.3,1);
	position:fixed;inset:0;pointer-events:none;color-scheme:dark;
	font:500 13px/18px var(--font);font-feature-settings:normal;letter-spacing:normal;
	color:var(--ink);text-align:left;direction:ltr;-webkit-font-smoothing:antialiased;
	user-select:none;-webkit-user-select:none;cursor:default;
}
.stage{z-index:2147483646}
.picker{z-index:2147483647}
.stage.off,.picker:not(.on){display:none}
.concealed{opacity:0!important}
.concealed,.concealed *{pointer-events:none!important}

.glass{
	background:var(--glass);border:1px solid var(--line);
	-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);
}
.mark{width:14px;height:14px;flex:none}
.icon{width:16px;height:16px;flex:none}

button{
	all:unset;box-sizing:border-box;position:relative;flex:none;
	display:inline-flex;align-items:center;justify-content:center;gap:6px;
	height:28px;padding:0 10px;border-radius:8px;
	font:500 12.5px/16px var(--font);color:var(--ink);white-space:nowrap;
	cursor:pointer;pointer-events:auto;
	transition:background-color .12s ease,color .12s ease,opacity .12s ease;
}
button:focus-visible{outline:2px solid var(--cyan);outline-offset:1px}
button:active{transform:translateY(.5px)}
.open{background:rgba(255,255,255,.08)}
.open:hover{background:rgba(255,255,255,.14)}

.tip{
	position:absolute;left:50%;top:calc(100% + 9px);padding:4px 8px;border-radius:6px;
	background:#17171a;border:1px solid rgba(255,255,255,.13);box-shadow:0 4px 14px rgba(0,0,0,.3);
	font:500 12px/16px var(--font);color:var(--ink);white-space:nowrap;pointer-events:none;
	opacity:0;transform:translateX(-50%) scale(.98);transition:opacity .12s ease,transform .12s ease;
}
button:hover>.tip,button:focus-visible>.tip{opacity:1;transform:translateX(-50%) scale(1);transition-delay:.3s}
.pill .tip,.tag[data-edge=bottom] .tip{top:auto;bottom:calc(100% + 9px)}
.pill button:hover>.tip,.pill button:focus-visible>.tip{transition-delay:.2s}

/* ---- edge ---- */
.glow,.frame{position:absolute;inset:0;opacity:0;transition:opacity .3s ease}
.glow.on,.frame.on{opacity:1}
.glow::before{
	content:"";position:absolute;inset:0;
	box-shadow:inset 0 0 22px rgba(237,74,191,.35),inset 0 0 44px rgba(237,74,191,.2),inset 0 0 66px rgba(90,216,230,.1);
}
.glow.on::before{animation:omp-pulse 2s ease-in-out infinite}
.frame{border:3px solid transparent;border-image:linear-gradient(100deg,#5ad8e6,#ed4abf) 1}
@keyframes omp-pulse{0%,100%{opacity:.6}50%{opacity:1}}

/* ---- working tag ---- */
.tag{
	position:absolute;left:8px;right:8px;top:0;margin:0 auto;width:fit-content;max-width:calc(100vw - 16px);
	height:40px;padding:3px 6px 0 12px;display:flex;align-items:center;gap:4px;
	border-top:0;border-radius:0 0 12px 12px;box-shadow:0 2px 8px rgba(0,0,0,.28);pointer-events:auto;
	opacity:0;visibility:hidden;transform:translateY(-100%);
	transition:transform .26s var(--ease),opacity .16s ease,visibility 0s linear .26s;
}
.tag[data-edge=bottom]{
	top:auto;bottom:0;padding:0 6px 3px 12px;border-top:1px solid var(--line);border-bottom:0;
	border-radius:12px 12px 0 0;box-shadow:0 -2px 8px rgba(0,0,0,.28);transform:translateY(100%);
}
.tag.on,.tag[data-edge=bottom].on{opacity:1;visibility:visible;transform:none;transition-delay:0s}
.tag .mark{margin-right:4px}
.tag-label{display:flex;min-width:0;margin-right:4px;font-weight:600;white-space:nowrap}
.tag-title{overflow:hidden;text-overflow:ellipsis}
.tag-live{flex:none;overflow:hidden;font-weight:500;color:var(--muted)}
.tag-live-text{display:inline-block}
.tag-live-text:not(:empty)::before{content:"·";margin:0 6px;color:var(--faint)}
.move{width:24px;height:24px;padding:0;border-radius:6px;color:var(--muted);opacity:0}
.tag:hover .move,.tag:has(:focus-visible) .move{opacity:1}
.move:hover{background:rgba(255,255,255,.08);color:var(--ink)}
.move .icon{transition:transform .2s ease}
.tag[data-edge=bottom] .move .icon{transform:rotate(180deg)}
.stop{background:rgba(255,97,102,.18);color:#ff8a8e}
.stop:hover{background:rgba(255,97,102,.28)}
.stop-glyph{width:9px;height:9px;border-radius:2px;background:currentColor}
.stop:disabled{cursor:default;background:rgba(255,97,102,.12)}
.stop:disabled .stop-glyph{
	width:11px;height:11px;border-radius:50%;background:none;
	border:1.5px solid rgba(255,138,142,.3);border-top-color:#ff8a8e;animation:omp-spin .7s linear infinite;
}
@keyframes omp-spin{to{transform:rotate(360deg)}}

/* ---- needs-input tag, group pill, toast ---- */
.ask,.pill,.toast{
	position:absolute;left:8px;right:8px;margin:0 auto;width:fit-content;max-width:calc(100vw - 16px);
	display:flex;align-items:center;box-shadow:var(--float);
	opacity:0;visibility:hidden;transition:transform .26s var(--ease),opacity .16s ease,visibility 0s linear .26s;
}
.ask.on,.pill.on,.toast.on{opacity:1;visibility:visible;transform:none;transition-delay:0s}
.ask,.pill{pointer-events:auto}
.ask{top:20px;height:40px;padding:0 6px 0 12px;gap:8px;border-radius:12px;font-weight:600;transform:translateY(-8px)}
.ask[data-edge=bottom]{top:auto;bottom:20px;transform:translateY(8px)}
.ask[data-edge=bottom].on{transform:none}
.ask .open{margin-left:8px}
.dot{position:relative;width:10px;height:10px;margin:0 2px;border-radius:50%;background:#f5a524;flex:none}
.dot::after{content:"";position:absolute;inset:0;border-radius:50%;background:#f5a524;opacity:0}
.on>.dot{animation:omp-beat 1.2s ease-in-out infinite}
.on>.dot::after{animation:omp-ping 1.2s ease-out infinite}
@keyframes omp-beat{0%,100%{opacity:1}50%{opacity:.72}}
@keyframes omp-ping{from{transform:scale(1);opacity:.55}to{transform:scale(2.6);opacity:0}}
.pill{bottom:16px;padding:6px 6px 6px 14px;gap:4px;border-radius:14px;transform:translateY(8px)}
.pill-lead{display:flex;flex:none}
.pill-text{min-width:0;margin:0 10px 0 6px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.rule{width:1px;height:28px;margin-right:2px;background:var(--line);flex:none}
.pill button{width:32px;height:32px;padding:0;color:var(--muted)}
.pill button:hover{background:rgba(255,255,255,.08);color:var(--ink)}
.toast{bottom:88px;padding:8px 14px;border-radius:18px;transform:translateY(6px);transition-duration:.2s,.2s,0s;transition-delay:0s,0s,.2s}

/* ---- arrow, chip, ring ---- */
.cursors{position:absolute;inset:0;forced-color-adjust:none}
.cursor{position:absolute;left:0;top:0;width:0;height:0;opacity:0;transition:opacity .2s linear}
.cursor.on{opacity:1;transition-duration:.12s}
.lean,.pose{position:absolute;left:0;top:0;width:0;height:0;transform-origin:0 0}
.pose{transition:transform .2s ease-out}
.cursor.rest .pose{transform:scale(.8)}
.arrow{
	position:absolute;left:-1.154px;top:-1.15px;width:20px;height:23px;overflow:visible;
	filter:drop-shadow(0 1px 2px rgba(0,0,0,.35));
}
.arrow path{
	fill:var(--pink);stroke:#fff;stroke-width:1.5;stroke-linejoin:round;vector-effect:non-scaling-stroke;
	transition:fill-opacity .2s ease-out;
}
.cursor.rest .arrow path{fill-opacity:.55}
.chip{
	position:absolute;left:0;top:0;height:22px;max-width:220px;padding:3px 8px;
	font:500 12px/16px var(--font);color:#fff;background:#c42596;box-shadow:0 1px 3px rgba(0,0,0,.18);
	white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-radius:3px 10px 10px 10px;
	opacity:0;transition:opacity .2s linear;
}
.chip.flip{border-radius:10px 3px 10px 10px}
.chip.on{opacity:1;transition-duration:.08s}
.ring{
	position:absolute;left:0;top:0;width:32px;height:32px;margin:-16px 0 0 -16px;border-radius:50%;
	border:2.5px solid var(--cyan);background:rgba(90,216,230,.22);
	animation:omp-ring .6s var(--ease) both;
}
@keyframes omp-ring{from{scale:.2;opacity:.95}to{scale:1;opacity:0}}
@keyframes omp-ring-still{from{opacity:.95}to{opacity:0}}

/* ---- pickers ---- */
.scrim{position:absolute;inset:0;pointer-events:auto;cursor:crosshair;touch-action:none;animation:omp-fade .12s ease}
@keyframes omp-fade{from{opacity:0}}
.outline{
	position:absolute;left:0;top:0;border:2px solid var(--cyan);border-radius:4px;
	background:rgba(90,216,230,.08);box-shadow:0 0 0 4px rgba(90,216,230,.18);
	transition:transform .07s ease-out,width .07s ease-out,height .07s ease-out;
}
.pick-chip,.size{
	position:absolute;left:0;top:0;border-radius:6px;font:600 11px/16px var(--mono);white-space:nowrap;
	box-shadow:0 2px 8px rgba(0,0,0,.28);
}
.pick-chip{max-width:calc(100vw - 8px);padding:3px 8px;overflow:hidden;text-overflow:ellipsis}
.size{padding:2px 6px;font-weight:500}
.hint{
	position:absolute;left:8px;right:8px;bottom:20px;margin:0 auto;width:fit-content;max-width:calc(100vw - 16px);
	padding:8px 16px;border-radius:999px;box-shadow:var(--float);text-align:center;transition:opacity .15s ease;
}
.hint.mid{bottom:auto;top:50%;transform:translateY(-50%)}
.hint.gone{opacity:0}
.sep{margin:0 8px;color:var(--faint)}
kbd{
	display:inline-block;margin-right:2px;padding:0 5px;border-radius:4px;font:500 11px/16px var(--mono);
	color:var(--ink);background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.18);
}
.shade{position:absolute;background:rgba(0,0,0,.35)}
.sel{position:absolute;left:0;top:0;border:1px dashed var(--cyan)}

/* ---- media ---- */
@media (pointer:coarse),(hover:none){
	button{height:44px;min-width:44px;padding:0 14px}
	.tag,.ask{height:52px}
	.move{width:44px;height:44px;opacity:1}
	.pill button{width:44px;height:44px}
	.rule{height:36px}
}
@media (prefers-reduced-motion:reduce){
	.glow.on::before,.on>.dot,.on>.dot::after{animation:none}
	.ring{animation-name:omp-ring-still}
	.scrim{animation:none}
	.tag,.ask,.pill,.toast,.tip,.pose,.outline,.move .icon,.arrow path{transition-duration:0s!important;transition-delay:0s!important}
	.tag,.tag[data-edge=bottom],.ask,.ask[data-edge=bottom],.pill,.toast{transform:none}
	.tip,button:hover>.tip,button:focus-visible>.tip{transform:translateX(-50%)}
	button:active{transform:none}
}
@media (forced-colors:active){
	.glow{display:none}
	.frame{border-image:none;border-color:ButtonText}
	.glass,.tip{background:Canvas;border-color:ButtonText;-webkit-backdrop-filter:none;backdrop-filter:none}
	button{border:1px solid ButtonText}
	.stop-glyph,.dot,.rule{forced-color-adjust:none}
	.stop-glyph,.rule{background:ButtonText}
	.stop:disabled .stop-glyph{background:none;border-color:GrayText;border-top-color:ButtonText}
	.outline{border-color:Highlight;background:none;box-shadow:none}
	.sel{border-color:Highlight}
}
@media print{
	.stage,.picker{display:none!important}
}
`;
