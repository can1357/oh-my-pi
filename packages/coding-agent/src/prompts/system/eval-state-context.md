<system-reminder>
Eval runtime state is host-retained, not reconstructed from transcript text.
{{#if stateSummary}}
{{stateSummary}}
{{else}}
No retained eval runtime is registered in this process. Eval variables, imports, and kernels referenced in earlier session history were not restored; re-run required setup before using them.
{{/if}}
Dead or absent kernel → re-run needed setup. Alive kernel → reuse retained definitions. An omitted script path does not mean its definitions were lost. NEVER infer variable values from this snapshot.
</system-reminder>
