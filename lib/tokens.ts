/**
 * Token counting and system-prompt decomposition.
 *
 * The prompt is assembled by Pi as an untagged preamble plus XML-wrapped sections
 * (`docs/extensions.md`, `dist/core/system-prompt.js:68-120`). Every number here comes
 * from the actual prompt text, so the audit never guesses how Pi formats something.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

type Encoder = (text: string) => number[];

let encoder: Encoder | undefined;
let tokenizerLabel = "chars/4";

// The extension must keep loading if the tokenizer dependency is missing (local trial
// checkout without `npm install`), so resolve it defensively instead of a static import.
try {
	const require = createRequire(import.meta.url);
	const mod = require("gpt-tokenizer/encoding/o200k_base") as { encode?: Encoder };
	if (typeof mod.encode === "function") {
		encoder = mod.encode;
		tokenizerLabel = "o200k";
	}
} catch {
	encoder = undefined;
}

const CACHE_LIMIT = 500;
const cache = new Map<string, number>();

/** Mirrors Pi's own estimator (`dist/core/compaction/compaction.js:201`). */
export function estimateFromChars(text: string): number {
	return Math.ceil(text.length / 4);
}

export function countTokens(text: string): number {
	if (!text) return 0;
	const hit = cache.get(text);
	if (hit !== undefined) return hit;
	const count = encoder ? encoder(text).length : estimateFromChars(text);
	if (cache.size >= CACHE_LIMIT) cache.clear();
	cache.set(text, count);
	return count;
}

export function tokenizerName(): string {
	return tokenizerLabel;
}

export interface PromptSection {
	name: string;
	text: string;
	tokens: number;
}

export interface ParsedPrompt {
	preamble: string;
	sections: PromptSection[];
	total: number;
}

const SECTION_OPEN = /^<([a-z][a-z0-9_-]*)>$/;
const PROJECT_FILE = /<project_instructions path="([^"]*)">\n([\s\S]*?)\n<\/project_instructions>/g;

export function parsePrompt(raw: string): ParsedPrompt {
	const preamble: string[] = [];
	const sections: PromptSection[] = [];
	let current: { name: string; lines: string[] } | undefined;

	for (const line of raw.split("\n")) {
		if (current) {
			if (line === `</${current.name}>`) {
				const text = current.lines.join("\n");
				sections.push({ name: current.name, text, tokens: countTokens(text) });
				current = undefined;
				continue;
			}
			current.lines.push(line);
			continue;
		}
		const open = SECTION_OPEN.exec(line);
		if (open) {
			current = { name: open[1]!, lines: [] };
			continue;
		}
		preamble.push(line);
	}

	// An unterminated section (hand-edited forced prompt) is still reported, not dropped.
	if (current) {
		const text = current.lines.join("\n");
		sections.push({ name: current.name, text, tokens: countTokens(text) });
	}

	return { preamble: preamble.join("\n"), sections, total: countTokens(raw) };
}

export function parseProjectFiles(sectionText: string | undefined): Array<{ path: string; content: string }> {
	if (!sectionText) return [];
	const files: Array<{ path: string; content: string }> = [];
	PROJECT_FILE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PROJECT_FILE.exec(sectionText))) {
		files.push({ path: match[1]!, content: match[2]! });
	}
	return files;
}

function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

export interface SkillLike {
	name: string;
	description: string;
	filePath: string;
}

/** One `<skill>` entry exactly as `formatSkillsForPrompt` emits it (`dist/core/skills.js:294-299`). */
export function skillBlock(skill: SkillLike): string {
	return [
		"  <skill>",
		`    <name>${escapeXml(skill.name)}</name>`,
		`    <description>${escapeXml(skill.description)}</description>`,
		`    <location>${escapeXml(skill.filePath)}</location>`,
		"  </skill>",
	].join("\n");
}

export function skillAdvertisedTokens(skill: SkillLike): number {
	return countTokens(skillBlock(skill));
}

export function skillFileTokens(filePath: string): number {
	try {
		return countTokens(readFileSync(filePath, "utf-8"));
	} catch {
		return 0;
	}
}

export interface ToolLike {
	name: string;
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
	exposure: string;
}

export function toolDeclarationText(tool: ToolLike): string {
	const body: Record<string, unknown> = {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	};
	if (tool.promptGuidelines?.length) body.guidelines = tool.promptGuidelines;
	return JSON.stringify(body);
}

export function toolDeclarationTokens(tool: ToolLike): number {
	return countTokens(toolDeclarationText(tool));
}

export interface AuditInput {
	/**
	 * The assembled system prompt WITHOUT session toggles applied. Command handlers read
	 * this from `ctx.getSystemPrompt()`, which reports the base prompt inputs.
	 */
	prompt: string;
	skills: Array<SkillLike & { id: string; disabled: boolean; advertised: boolean }>;
	tools: Array<ToolLike & { active: boolean; baselineActive: boolean; disabled: boolean; source: string }>;
}

export interface SkillCostEntry {
	id: string;
	advertised: number;
	full: number;
}

export interface AuditResult {
	sections: PromptSection[];
	preamble: string;
	preambleTokens: number;
	promptTokens: number;
	estimatedTokens: number;
	skillsSectionTokens: number;
	skillHeaderTokens: number;
	skillCosts: SkillCostEntry[];
	projectFiles: Array<{ path: string; tokens: number }>;
	toolCosts: Record<string, number>;
	activeToolTokens: number;
	baselineToolTokens: number;
	/** System prompt + tool declarations with session toggles applied. */
	projectedTokens: number;
	/** Tokens the current session toggles remove from the next request. */
	savings: number;
}

export function auditPrompt(input: AuditInput): AuditResult {
	const parsed = parsePrompt(input.prompt);
	const sectionByName = new Map(parsed.sections.map((section) => [section.name, section]));
	const skillsSectionTokens = sectionByName.get("skills")?.tokens ?? 0;

	const skillCosts: SkillCostEntry[] = input.skills.map((skill) => ({
		id: skill.id,
		advertised: skill.advertised ? skillAdvertisedTokens(skill) : 0,
		full: skillFileTokens(skill.filePath),
	}));
	const advertisedTotal = skillCosts.reduce((sum, cost) => sum + cost.advertised, 0);
	// Header = the prose around the <skill> entries. Clamped because a forced custom
	// prompt may contain a hand-written skills section with different formatting.
	const skillHeaderTokens = Math.max(0, skillsSectionTokens - advertisedTotal);

	const toolCosts: Record<string, number> = {};
	for (const tool of input.tools) toolCosts[tool.name] = toolDeclarationTokens(tool);
	const sumTools = (predicate: (tool: AuditInput["tools"][number]) => boolean) =>
		input.tools.filter(predicate).reduce((sum, tool) => sum + (toolCosts[tool.name] ?? 0), 0);

	const activeToolTokens = sumTools((tool) => tool.active);
	const baselineToolTokens = sumTools((tool) => tool.baselineActive);
	// Only the tools this extension switched off count as savings; anything else that went
	// inactive (another extension, a late registration) is not ours to claim.
	const disabledToolTokens = sumTools((tool) => tool.disabled);

	const disabledSkillIds = new Set(input.skills.filter((skill) => skill.disabled).map((skill) => skill.id));
	const disabledSkillTokens = skillCosts
		.filter((cost) => disabledSkillIds.has(cost.id))
		.reduce((sum, cost) => sum + cost.advertised, 0);

	const savings = disabledSkillTokens + disabledToolTokens;
	const projectedTokens = Math.max(0, parsed.total - disabledSkillTokens + activeToolTokens);

	const projectFiles = parseProjectFiles(sectionByName.get("project_context")?.text).map((file) => ({
		path: file.path,
		tokens: countTokens(file.content),
	}));

	return {
		sections: parsed.sections,
		preamble: parsed.preamble,
		preambleTokens: countTokens(parsed.preamble),
		promptTokens: parsed.total,
		estimatedTokens: estimateFromChars(input.prompt),
		skillsSectionTokens,
		skillHeaderTokens,
		skillCosts,
		projectFiles,
		toolCosts,
		activeToolTokens,
		baselineToolTokens,
		projectedTokens,
		savings,
	};
}
