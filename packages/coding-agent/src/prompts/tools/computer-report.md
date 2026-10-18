{{#if webContent}}web pages send no accessibility notification while they wait on the network or a timer, so this read may predate a load; the next report shows what lands later{{/if}}
{{#if stillChanging}}the app was still changing when this was read, {{stillChanging}} s after the input{{/if}}
{{#if budgetSpent}}window {{budgetSpent}} was not read back: the report's time budget is spent; read it yourself{{/if}}
{{#if noFocusedWindow}}input whose window was unknown reached no window to read back (no focused window found); look before continuing{{/if}}
{{#if leftOut}}{{leftOut}}: its tree was left out to keep this report short; win.ax() prints it{{/if}}
{{#if noReport}}No post-input report for this cell ({{noReport}}); read the windows it touched before continuing.{{/if}}
