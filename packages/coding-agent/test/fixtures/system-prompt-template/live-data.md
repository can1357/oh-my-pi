TOOLS={{#list tools join=","}}{{this}}{{/list}}
DEVICES={{#list xdevTools join=","}}{{name}}={{summary}}{{/list}}
DOCS={{xdevDocs}}
{{#if computerEnabled}}COMPUTER=enabled{{else}}COMPUTER=disabled{{/if}}
