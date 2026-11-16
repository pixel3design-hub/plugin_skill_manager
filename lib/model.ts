/**
 * Shared data model for the skill manager. Plain data only: every module in `lib/`
 * is host-free at runtime so tests can run without Pi installed.
 */

export type RowKind = "skill" | "plugin" | "catalog" | "section" | "tool";

/**
 * enabled  - active right now (green bg)
 * disabled - turned off by the user for this session (default bg)
 * forced   - cannot be turned on in this session (red bg)
 * available- not installed, recommended (yellow bg)
 */
export type RowState = "enabled" | "disabled" | "forced" | "available";

export interface Row {
	kind: RowKind;
	id: string;
	name: string;
	description: string;
	/** Package source, directory, or "builtin". */
	source: string;
	scope: string;
	/** Advertised prompt cost in tokens. */
	tokens: number;
	/** Skill only: cost of loading the full SKILL.md. */
	fullTokens?: number;
	state: RowState;
	reason?: string;
	/** What a toggle switches; undefined means the row is not toggleable. */
	toggle?: "skill" | "plugin";
	toolNames?: string[];
	install?: string;
	path?: string;
	score?: number;
	reasons?: string[];
}

export interface SessionState {
	disabledSkills: string[];
	disabledTools: string[];
}


export interface CatalogEntry {
	id: string;
	kind: "plugin" | "skill";
	name: string;
	description: string;
	keywords: string[];
	install: string;
}

