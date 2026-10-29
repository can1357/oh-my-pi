export * from "./e6-triplestore-split";
// e7 re-uses e6's generic names (migrate, hasPendingMigration, MigrationOptions); star-exporting
// both would make those names ambiguous and silently drop them from this barrel, so e7's
// members are re-exported under unique names here.
export {
	FACTS_SCOPE_COLUMN,
	FACTS_SCOPE_DEFAULT,
	FACTS_SCOPE_GLOBAL,
	hasPendingMigration as hasPendingFactsScopeMigration,
	migrate as migrateFactsScope,
	type MigrationOptions as FactsScopeMigrationOptions,
} from "./e7-facts-scope";
