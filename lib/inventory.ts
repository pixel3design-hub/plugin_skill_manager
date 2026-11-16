/**
 * Turns Pi's live resource data (loaded skills, registered tools, settings packages)
 * into the rows the TUI renders. Everything is host-exposed data: no resource loader,
 * no package manager, so this never triggers an install or a second extension load.
 */

import type { Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { CatalogEntry, Row, SessionState } from "./model.ts";
import { computeActiveTools } from "./state.ts";
import { skillAdvertisedTokens, skillFileTokens, toolDeclarationTokens } from "./tokens.ts";

/** Tools shipped by Pi's core (path `builtin:<same name>`), grouped into one row. */
const CORE_TOOLS = new Set(["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"]);
const CORE_ROW_ID = "builtin:core";
const SKILL_ONLY_SOURCES = new Set(["builtin", "sdk", "cli", "local"]);
/** Tool sources that are not packages, so they get no plugin row of their own. */
const NON_PACKAGE_TOOL_SOURCES = new Set(["sdk", "cli", "local"]);

export interface PackageSetting {
	source: string;
}

export interface SettingsLike {
	packages?: Array<string | PackageSetting>;
	extensions?: string[];
}

export interface InventoryInput {
	skills: Skill[];
	tools: ToolInfo[];
	/** Extension commands, attributed to their package (`pi.getCommands()`). */
	commands?: Array<{ name: string; source: string }>;
	/** Tools activated at session start, before this extension applied its state. */
	baselineTools: string[];
	settings: SettingsLike;
	state: SessionState;
	catalog: CatalogEntry[];
}

export interface Inventory {
	skills: Row[];
	plugins: Row[];
	catalog: Row[];
}

export interface SkillCosts {
	advertised: number;
	full: number;
}

export function skillRowId(skill: Pick<Skill, "name">): string {
	return `skill:${skill.name}`;
}

export function toolCost(tool: ToolInfo): number {
	return toolDeclarationTokens({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		promptGuidelines: tool.promptGuidelines,
		exposure: tool.exposure,
	});
}

export function skillCosts(skill: Skill): SkillCosts {
	return { advertised: skillAdvertisedTokens(skill), full: skillFileTokens(skill.filePath) };
}

function packageSource(entry: string | PackageSetting): string | undefined {
	if (typeof entry === "string") return entry.startsWith("-") || entry.startsWith("+") ? undefined : entry;
	if (entry && typeof entry.source === "string") return entry.source;
	return undefined;
}

function pluginIdForTool(tool: ToolInfo): string {
	const { source, path } = tool.sourceInfo;
	if (source === "builtin") {
		return CORE_TOOLS.has(tool.name) || path === `builtin:${tool.name}` ? CORE_ROW_ID : path;
	}
	return source;
}

function pluginIdForSkill(skill: Skill): string | undefined {
	const { source, origin } = skill.sourceInfo;
	if (origin !== "package" || SKILL_ONLY_SOURCES.has(source)) return undefined;
	return source;
}

function pluginLabel(id: string): string {
	if (id === CORE_ROW_ID) return "pi built-in tools";
	if (id.startsWith("npm:")) return id.slice(4);
	const segment = id.split("/").filter(Boolean).pop();
	return segment ?? id;
}

export function buildInventory(input: InventoryInput): Inventory {
	const disabledSkills = new Set(input.state.disabledSkills);
	const active = new Set(computeActiveTools(input.baselineTools, input.state));
	const baseline = new Set(input.baselineTools);

	const skillRows: Row[] = input.skills.map((skill) => {
		const costs = skillCosts(skill);
		const forced = skill.disableModelInvocation;
		const disabled = !forced && disabledSkills.has(skillRowId(skill));
		return {
			kind: "skill",
			id: skillRowId(skill),
			name: skill.name,
			description: skill.description,
			source: skill.sourceInfo.source,
			scope: skill.sourceInfo.scope,
			tokens: forced ? 0 : costs.advertised,
			fullTokens: costs.full,
			state: forced ? "forced" : disabled ? "disabled" : "enabled",
			reason: forced ? "hidden from the model, /skill:" + skill.name + " only" : undefined,
			toggle: forced ? undefined : "skill",
			path: skill.filePath,
		};
	});

	const plugins = new Map<string, Row>();
	const ensurePlugin = (id: string): Row => {
		const existing = plugins.get(id);
		if (existing) return existing;
		const row: Row = {
			kind: "plugin",
			id,
			name: pluginLabel(id),
			description: "",
			source: id,
			scope: "user",
			tokens: 0,
			state: "enabled",
			toolNames: [],
		};
		plugins.set(id, row);
		return row;
	};

	for (const tool of input.tools) {
		if (tool.exposure !== "direct") continue;
		if (NON_PACKAGE_TOOL_SOURCES.has(tool.sourceInfo.source)) continue;
		const row = ensurePlugin(pluginIdForTool(tool));
		row.toolNames!.push(tool.name);
		row.tokens += toolCost(tool);
	}

	const commandCounts = new Map<string, number>();
	for (const command of input.commands ?? []) {
		if (SKILL_ONLY_SOURCES.has(command.source)) continue;
		commandCounts.set(command.source, (commandCounts.get(command.source) ?? 0) + 1);
	}

	for (const skill of input.skills) {
		const id = pluginIdForSkill(skill);
		if (!id) continue;
		const row = ensurePlugin(id);
		row.tokens += skill.disableModelInvocation ? 0 : skillAdvertisedTokens(skill);
	}

	for (const entry of input.settings.packages ?? []) {
		const source = packageSource(entry);
		if (source) ensurePlugin(source);
	}
	for (const entry of input.settings.extensions ?? []) {
		const source = packageSource(entry);
		if (source && !source.startsWith("builtin:")) ensurePlugin(source);
	}

	for (const row of plugins.values()) {
		const toolNames = row.toolNames ?? [];
		const pluginSkills = skillRows.filter((skill) => skill.source === row.id);
		const commands = commandCounts.get(row.id) ?? 0;
		if (row.id === CORE_ROW_ID) {
			const inactive = toolNames.filter((name) => !active.has(name)).length;
			row.scope = "builtin";
			row.description = "Core tools shipped with Pi";
			row.reason = `${toolNames.length - inactive}/${toolNames.length} active`;
			row.toggle = undefined;
			row.state = inactive === toolNames.length ? "forced" : "enabled";
			continue;
		}
		if (toolNames.length === 0) {
			const advertised = pluginSkills.filter((skill) => skill.state !== "forced");
			row.toggle = undefined;
			if (advertised.length > 0) {
				row.state = "enabled";
				row.description = `${advertised.length} skills, no tools`;
				row.reason = `${advertised.length} skills`;
			} else if (commands > 0) {
				row.state = "enabled";
				row.description = `${commands} commands, no tools`;
				row.reason = `${commands} commands`;
			} else {
				row.state = "forced";
				row.description = "nothing loaded in this session";
				row.reason = "package loaded no tools, skills or commands";
			}
			continue;
		}
		const disabledCount = toolNames.filter((name) => !active.has(name)).length;
		row.toggle = "plugin";
		if (toolNames.every((name) => !baseline.has(name))) {
			row.state = "forced";
			row.reason = "not active at startup (defaultTools)";
		} else if (disabledCount === toolNames.length) {
			row.state = "disabled";
			row.reason = `${toolNames.length} tools off`;
		} else if (disabledCount > 0) {
			row.state = "disabled";
			row.reason = `${disabledCount}/${toolNames.length} tools off`;
		} else {
			row.state = "enabled";
			row.reason = `${toolNames.length} tools`;
		}
		row.description = row.description || pluginSkills.map((skill) => skill.name).join(", ");
		if (commands > 0) row.reason = `${row.reason} · ${commands} commands`;
	}

	const installed = new Set([
		...plugins.keys(),
		...(input.settings.packages ?? []).flatMap((entry) => {
			const source = packageSource(entry);
			return source ? [source] : [];
		}),
	]);
	const catalogRows: Row[] = input.catalog
		.filter((entry) => !installed.has(entry.id))
		.map((entry) => ({
			kind: "catalog",
			id: entry.id,
			name: entry.name,
			description: entry.description,
			source: "catalog",
			scope: "external",
			tokens: 0,
			state: "available",
			install: entry.install,
			reasons: entry.keywords,
		}));

	return {
		skills: skillRows.sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)),
		plugins: [...plugins.values()].sort((a, b) => b.tokens - a.tokens || a.name.localeCompare(b.name)),
		catalog: catalogRows,
	};
}

