/**
 * Session-scoped toggle state.
 *
 * Nothing here writes settings: "off" only lasts for the running session and is
 * persisted as a custom session entry (no LLM context) so /resume and extension
 * reloads keep it.
 */

import type { SessionState } from "./model.ts";

export const STATE_ENTRY_TYPE = "skill-manager:state";

export interface SkillIdentity {
	id: string;
	name: string;
	disableModelInvocation?: boolean;
}

export interface ToolIdentity {
	name: string;
	exposure: string;
}

export function normalizeState(input: Partial<SessionState> | undefined): SessionState {
	return {
		disabledSkills: [...new Set((input?.disabledSkills ?? []).filter(isString))],
		disabledTools: [...new Set((input?.disabledTools ?? []).filter(isString))],
	};
}

function isString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

export function toggle(values: string[], value: string): string[] {
	return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

export function toggleSkill(state: SessionState, skillId: string): SessionState {
	return { ...state, disabledSkills: toggle(state.disabledSkills, skillId) };
}

export function toggleTools(state: SessionState, toolNames: string[]): SessionState {
	let disabled = state.disabledTools;
	const allDisabled = toolNames.length > 0 && toolNames.every((name) => disabled.includes(name));
	for (const name of toolNames) {
		disabled = allDisabled
			? disabled.filter((entry) => entry !== name)
			: disabled.includes(name)
				? disabled
				: [...disabled, name];
	}
	return { ...state, disabledTools: disabled };
}

/**
 * Skills that Pi advertises to the model, minus the ones turned off for this session.
 * `disable-model-invocation` skills are excluded by Pi itself.
 */
export function filterSkills<T extends SkillIdentity>(skills: T[], state: SessionState): T[] {
	if (state.disabledSkills.length === 0) return skills;
	const disabled = new Set(state.disabledSkills);
	return skills.filter((skill) => skill.disableModelInvocation || !disabled.has(skill.id));
}

/**
 * Active tool list under the current state. `baseline` is what Pi activated at startup,
 * so a tool that was never active cannot be resurrected from here.
 */
export function computeActiveTools(baseline: string[], state: SessionState): string[] {
	if (state.disabledTools.length === 0) return [...baseline];
	const disabled = new Set(state.disabledTools);
	return baseline.filter((name) => !disabled.has(name));
}

export function parseStateEntry(data: unknown): SessionState | undefined {
	if (!data || typeof data !== "object") return undefined;
	const record = data as Record<string, unknown>;
	if (!Array.isArray(record.disabledSkills) && !Array.isArray(record.disabledTools)) return undefined;
	return normalizeState({
		disabledSkills: Array.isArray(record.disabledSkills) ? record.disabledSkills.filter(isString) : [],
		disabledTools: Array.isArray(record.disabledTools) ? record.disabledTools.filter(isString) : [],
	});
}

export interface StateEntryLike {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Last state entry on the branch wins. */
export function restoreState(entries: StateEntryLike[]): SessionState {
	let restored: SessionState | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const parsed = parseStateEntry(entry.data);
		if (parsed) restored = parsed;
	}
	return restored ?? normalizeState(undefined);
}
