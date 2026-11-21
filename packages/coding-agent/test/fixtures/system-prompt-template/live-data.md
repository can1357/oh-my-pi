TOOLS={{#list tools join=","}}{{this}}{{/list}}
COMMANDS={{#list mountedCommands join=","}}{{name}}={{summary}}{{/list}}
DOCS={{toolCommandDocs}}
{{#if computerEnabled}}COMPUTER=enabled{{else}}COMPUTER=disabled{{/if}}
