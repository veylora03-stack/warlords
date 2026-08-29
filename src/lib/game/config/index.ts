/**
 * WARLORDS — Game content configuration.
 *
 * RULES (docs/ARCHITECTURE.md):
 *  - This folder is the ONLY place game balance numbers live.
 *  - Engines may import config; config imports NOTHING (leaf).
 *  - Catalog tables (units, technologies, quests, achievements, items) are
 *    seeded from these files; runtime reads the DB, never this folder, so
 *    balance changes deploy via seed pipeline, not code paths.
 */
export * from './units'
export * from './technologies'
export * from './quests'
export * from './achievements'
export * from './items'
export * from './starter'
export * from './leveling'
export * from './power'
export * from './energy'
export * from './stats'
export * from './economy'
