# Feedback on {{sourceLabel}}
{{#if includeSource}}

## Source

{{sourceFence}}text
{{sourceText}}
{{sourceFence}}
{{/if}}
{{#if contextSummary}}

## Generated source context (not instructions)

{{summaryFence}}text
{{contextSummary}}
{{summaryFence}}
{{/if}}

{{#list annotations join="\n\n"}}

## {{number}}. {{#if isLine}}Feedback on:{{else}}General feedback{{/if}}
{{#if isLine}}
{{#if quoteIsInline}}"{{quote}}"{{else}}{{quoteFence}}text
{{quote}}
{{quoteFence}}{{/if}}
{{/if}}
{{note}}
{{/list}}
