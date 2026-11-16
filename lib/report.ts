/**
 * Markdown report of the Pi installation as this session sees it.
 *
 * Pure: the extension collects the data (Pi API, settings, mcp.json) and passes plain objects
 * here, so the rendering is testable without a host.
 */

import type { Row, SessionState } from "./model.ts";

export interface ReportSection {
	name: string;
	tokens: number;
}

export interface ReportTool {
	name: string;
	exposure: string;
	active: boolean;
	tokens: number;
	source: string;
}

export interface ReportMcpServer {
	name: string;
	scope: string;
	/** "stdio <command>" or "http <host>"; never arguments, headers or tokens. */
	transport: string;
	exposure: string;
	registered: boolean;
	/** Deferred tool declarations this server contributes. */
	tools?: number;
	tokens?: number;
}

export interface ReportCommand {
	name: string;
	source: string;
	description?: string;
}

export interface ReportContextFile {
	path: string;
	tokens: number;
}

export interface ReportData {
	generatedAt: string;
	piVersion: string;
	cwd: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	tokenizer: string;
	prompt: {
		systemTokens: number;
		toolTokens: number;
		projectedTokens: number;
		savings: number;
		estimatedTokens: number;
		sections: ReportSection[];
	};
	skills: Row[];
	plugins: Row[];
	builtinTools: ReportTool[];
	mcp: ReportMcpServer[];
	commands: ReportCommand[];
	contextFiles: ReportContextFile[];
	themes?: string[];
	scopedModels?: string[];
	state: SessionState;
}

function tokenLabel(tokens: number): string {
	return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function escapeCell(value: string): string {
	return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function table(headers: string[], rows: string[][]): string {
	if (rows.length === 0) return "_None._";
	const head = `| ${headers.join(" | ")} |`;
	const rule = `| ${headers.map(() => "---").join(" | ")} |`;
	return [head, rule, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function stateWord(row: Row): string {
	if (row.state === "enabled") return "enabled";
	if (row.state === "disabled") return "off this session";
	return `locked${row.reason ? ` (${row.reason})` : ""}`;
}

function sumTokens(rows: Row[]): number {
	return rows.reduce((total, row) => total + row.tokens, 0);
}

export function renderReport(data: ReportData): string {
	const enabledSkills = data.skills.filter((row) => row.state === "enabled");
	const enabledPlugins = data.plugins.filter((row) => row.state === "enabled");
	const activeBuiltin = data.builtinTools.filter((tool) => tool.active);
	const commandCount = data.commands.length;

	const lines: string[] = [];
	lines.push("# Pi installation report", "");
	lines.push(
		[
			`Generated ${data.generatedAt} · Pi ${data.piVersion}`,
			`model ${data.model ?? "unknown"}${data.thinking ? ` (thinking ${data.thinking})` : ""}`,
			`cwd \`${data.cwd}\``,
		].join("  \n"),
	);
	lines.push("");

	lines.push("## Summary", "");
	lines.push(
		table(
			["Item", "Count", "Prompt tokens"],
			[
				["Skills advertised", String(data.skills.length), tokenLabel(sumTokens(data.skills))],
				["Skills enabled", String(enabledSkills.length), tokenLabel(sumTokens(enabledSkills))],
				["Plugins / packages", String(data.plugins.length), tokenLabel(sumTokens(data.plugins))],
				["Plugins enabled", String(enabledPlugins.length), tokenLabel(sumTokens(enabledPlugins))],
				["Built-in tools", `${activeBuiltin.length}/${data.builtinTools.length} active`, tokenLabel(activeBuiltin.reduce((sum, tool) => sum + tool.tokens, 0))],
				["MCP servers", String(data.mcp.length), "—"],
				["Extension + prompt commands", String(commandCount), "—"],
				["Context files", String(data.contextFiles.length), tokenLabel(data.contextFiles.reduce((sum, file) => sum + file.tokens, 0))],
			],
		),
	);
	lines.push("");

	lines.push("## Prompt budget", "");
	lines.push(
		`System prompt ${tokenLabel(data.prompt.systemTokens)} tokens · tool declarations ${tokenLabel(data.prompt.toolTokens)} · next request ${tokenLabel(data.prompt.projectedTokens)} · saved this session ${tokenLabel(data.prompt.savings)} · tokenizer ${data.tokenizer} (chars/4 estimate ${tokenLabel(data.prompt.estimatedTokens)}).`,
	);
	lines.push("");
	lines.push(
		table(
			["Section", "Tokens", "Share"],
			data.prompt.sections
				.slice()
				.sort((a, b) => b.tokens - a.tokens)
				.map((section) => [
					escapeCell(section.name),
					String(section.tokens),
					`${Math.round((section.tokens / Math.max(1, data.prompt.systemTokens)) * 100)}%`,
				]),
		),
	);
	lines.push("");

	lines.push("## Skills", "");
	lines.push(
		table(
			["Skill", "Source", "Scope", "Prompt", "SKILL.md", "State"],
			data.skills.map((row) => [
				escapeCell(row.name),
				escapeCell(row.source),
				row.scope,
				row.state === "forced" ? "—" : String(row.tokens),
				row.fullTokens ? String(row.fullTokens) : "—",
				stateWord(row),
			]),
		),
	);
	lines.push("");

	lines.push("## Plugins and packages", "");
	lines.push(
		table(
			["Plugin", "Source", "Scope", "Tools", "Commands", "Prompt", "State"],
			data.plugins.map((row) => {
				const source = row.source;
				const commands = data.commands.filter((command) => command.source === source).length;
				return [
					escapeCell(row.name),
					escapeCell(source),
					row.scope,
					row.toolNames?.length ? `${row.toolNames.length} (${row.toolNames.join(", ")})` : "—",
					commands ? String(commands) : "—",
					`${row.tokens} tok`,
					stateWord(row),
				];
			}),
		),
	);
	lines.push("");

	lines.push("## Built-in helpers", "");
	lines.push("Core tools and built-in extension tools. MCP tools are counted in the MCP table above.");
	lines.push("");
	lines.push(
		table(
			["Tool", "Exposure", "Active", "Prompt", "Source"],
			data.builtinTools.map((tool) => [
				escapeCell(tool.name),
				tool.exposure,
				tool.active ? "yes" : "no",
				`${tool.tokens} tok`,
				escapeCell(tool.source),
			]),
		),
	);
	lines.push("");

	lines.push("## MCP servers", "");
	if (data.mcp.length === 0) lines.push("_None configured or registered._");
	else {
		lines.push(
			table(
				["Server", "Scope", "Transport", "Exposure", "Registered", "Tools", "Prompt"],
				data.mcp.map((server) => [
					escapeCell(server.name),
					server.scope,
					escapeCell(server.transport),
					server.exposure,
					server.registered ? "yes" : "no",
					server.tools !== undefined ? String(server.tools) : "—",
					server.tokens !== undefined ? `${server.tokens} tok` : "—",
				]),
			),
		);
		lines.push("");
		lines.push("Transport shows the command name or URL host only; arguments, headers and environment are not reported.");
	}
	lines.push("");

	lines.push("## Commands", "");
	lines.push(
		table(
			["Command", "Source", "Description"],
			data.commands.map((command) => [
				`\`/${escapeCell(command.name)}\``,
				escapeCell(command.source),
				escapeCell(command.description ?? ""),
			]),
		),
	);
	lines.push("");

	lines.push("## Context files", "");
	lines.push(
		table(
			["File", "Tokens"],
			data.contextFiles.map((file) => [`\`${escapeCell(file.path)}\``, String(file.tokens)]),
		),
	);
	lines.push("");

	const environment: Array<[string, string]> = [];
	if (data.sessionFile) environment.push(["Session file", `\`${data.sessionFile}\``]);
	if (data.themes?.length) environment.push(["Themes", data.themes.join(", ")]);
	if (data.scopedModels?.length) environment.push(["Scoped models", data.scopedModels.join(", ")]);
	environment.push([
		"This session off",
		`${data.state.disabledSkills.length} skills, ${data.state.disabledTools.length} tools`,
	]);
	lines.push("## Environment", "");
	lines.push(table(["Item", "Value"], environment.map(([key, value]) => [key, escapeCell(value)])));
	lines.push("");

	return `${lines.join("\n")}\n`;
}
