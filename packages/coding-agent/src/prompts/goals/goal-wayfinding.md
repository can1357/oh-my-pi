<wayfinding revision="{{revision}}">
{{#if focus}}
	<focus>{{escapeXml focus}}</focus>
{{/if}}
	<waypoint>
		<action>{{escapeXml waypoint.action}}</action>
		<rationale>{{escapeXml waypoint.rationale}}</rationale>
{{#if waypoint.guidance}}
		<guidance>{{escapeXml waypoint.guidance}}</guidance>
{{/if}}
{{#if waypoint.successSignal}}
		<success_signal>{{escapeXml waypoint.successSignal}}</success_signal>
{{/if}}
{{#if waypoint.replanIf}}
		<replan_if>{{escapeXml waypoint.replanIf}}</replan_if>
{{/if}}
	</waypoint>
{{#if lastObservation}}
	<last_observation outcome="{{escapeXml lastObservation.outcome}}">
		<summary>{{escapeXml lastObservation.summary}}</summary>
	</last_observation>
{{/if}}
{{#if blockers}}
	<blockers>
{{#each blockers}}
		<item>{{escapeXml this}}</item>
{{/each}}
	</blockers>
{{/if}}
{{#if assumptions}}
	<assumptions>
{{#each assumptions}}
		<item>{{escapeXml this}}</item>
{{/each}}
	</assumptions>
{{/if}}
</wayfinding>
