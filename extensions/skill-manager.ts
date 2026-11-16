/**
 * pi-skill-manager
 *
 * 1. `/prompt-tokens` — token audit of the assembled system prompt and tool declarations.
 * 2. `/resources`     — session-scoped on/off switches for skills and plugins.
 * 3. `/pick` + the `suggest_resources` tool — project-aware recommendations.
 *
 * Turning a plugin off deactivates its tools (`pi.setActiveTools`). Pi exposes no way to
 * unload an extension or to attribute extension-authored prompt sections, so its commands,
 * shortcuts and any text it appends to the system prompt keep working.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CONFIG_DIR_NAME,
	copyToClipboard,
	getAgentDir,
	VERSION,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type Skill,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildInventory, skillRowId, type Inventory, type SettingsLike } from "../lib/inventory.ts";
import type { CatalogEntry, Row, SessionState } from "../lib/model.ts";
import { buildSignals, rankRows, scanProject, summarizeSignals, type ScoredRow, type Signals } from "../lib/recommend.ts";
import { renderReport, type ReportData, type ReportMcpServer } from "../lib/report.ts";
import { restoreState, STATE_ENTRY_TYPE, toggleSkill, toggleTools } from "../lib/state.ts";
import { auditPrompt, skillBlock, tokenizerName, toolDeclarationTokens, type AuditResult } from "../lib/tokens.ts";
import { ManagerComponent, type ManagerModel, type Tab } from "../ui/manager.ts";

interface ManagerConfig {
	statusBadge?: boolean;
}

interface PromptOptionsLike {
	skills?: Skill[];
}

const STATUS_KEY = "skill-manager";
const REGISTRY_URL = "https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250";

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as T;
	} catch {
		return undefined;
	}
}

function loadConfig(): ManagerConfig {
	return readJson<ManagerConfig>(join(getAgentDir(), "skill-manager.json")) ?? {};
}

function loadStaticCatalog(): CatalogEntry[] {
	return readJson<CatalogEntry[]>(fileURLToPath(new URL("../lib/catalog.json", import.meta.url))) ?? [];
}

function formatTokens(tokens: number): string {
	return tokens >= 10000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

/** Pretty-printed for reading; the token cost is always measured on the compact form. */
function previewDeclaration(tool: {
	name: string;
	description: string;
	parameters: unknown;
	promptGuidelines?: string[];
	exposure: string;
}): string {
	const declaration: Record<string, unknown> = {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
	};
	if (tool.promptGuidelines?.length) declaration.guidelines = tool.promptGuidelines;
	return JSON.stringify(declaration, null, 2);
}

export default function skillManagerExtension(pi: ExtensionAPI) {
	let state: SessionState = restoreState([]);
	let baselineTools: string[] = [];
	let cachedSkills: Skill[] = [];
	let config: ManagerConfig = {};
	let liveCatalog: CatalogEntry[] = [];
	let signals: Signals | undefined;
	let lastBaselinePrompt: string | undefined;

	const catalog = (): CatalogEntry[] => {
		const staticEntries = loadStaticCatalog();
		const seen = new Set(staticEntries.map((entry) => entry.id));
		return [...staticEntries, ...liveCatalog.filter((entry) => !seen.has(entry.id))];
	};

	const settings = (): SettingsLike => pi.getSettings() as SettingsLike;

	/** Never drops tools another extension activated after startup. */
	function applyToolState(): void {
		const names = new Set([...pi.getActiveTools(), ...baselineTools]);
		for (const disabled of state.disabledTools) names.delete(disabled);
		pi.setActiveTools([...names]);
	}

	function persist(): void {
		pi.appendEntry(STATE_ENTRY_TYPE, {
			disabledSkills: state.disabledSkills,
			disabledTools: state.disabledTools,
		});
	}

	function skillsFrom(ctx: ExtensionContext): Skill[] {
		const commandCtx = ctx as Partial<ExtensionCommandContext>;
		if (typeof commandCtx.getSystemPromptOptions === "function") {
			const loaded = (commandCtx.getSystemPromptOptions() as PromptOptionsLike | undefined)?.skills;
			if (loaded) {
				cachedSkills = loaded;
				return loaded;
			}
		}
		return cachedSkills;
	}

	function buildAudit(prompt: string, skills: Skill[]): AuditResult {
		const active = new Set(pi.getActiveTools());
		const baseline = new Set(baselineTools);
		return auditPrompt({
			prompt,
			skills: skills.map((skill) => ({
				id: skillRowId(skill),
				name: skill.name,
				description: skill.description,
				filePath: skill.filePath,
				disabled: state.disabledSkills.includes(skillRowId(skill)),
				advertised: !skill.disableModelInvocation,
			})),
			tools: pi
				.getAllTools()
				.filter((tool) => tool.exposure === "direct")
				.map((tool) => ({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					promptGuidelines: tool.promptGuidelines,
					exposure: tool.exposure,
					source: tool.sourceInfo.source,
					active: active.has(tool.name) && !state.disabledTools.includes(tool.name),
					baselineActive: baseline.has(tool.name),
					disabled: state.disabledTools.includes(tool.name),
				})),
		});
	}

	function updateStatus(ctx: ExtensionContext, audit: AuditResult | undefined): void {
		if (!ctx.hasUI) return;
		if (config.statusBadge === false || !audit) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, `prompt ${formatTokens(audit.projectedTokens)}`);
	}

	function inventory(): Inventory {
		return buildInventory({
			skills: cachedSkills,
			tools: pi.getAllTools(),
			commands: pi
				.getCommands()
				.filter((command) => command.source === "extension")
				.map((command) => ({ name: command.name, source: command.sourceInfo.source })),
			baselineTools,
			settings: settings(),
			state,
			catalog: catalog(),
		});
	}

	function sectionRows(audit: AuditResult): Row[] {
		return [
			{
				kind: "section" as const,
				id: "section:preamble",
				name: "preamble",
				description: "Pi's base instructions",
				source: "prompt",
				scope: "session",
				tokens: audit.preambleTokens,
				state: "enabled" as const,
				reasons: [`${Math.round((audit.preambleTokens / Math.max(1, audit.promptTokens)) * 100)}%`],
			},
			...audit.sections.map((section) => ({
				kind: "section" as const,
				id: `section:${section.name}`,
				name: section.name,
				description: "",
				source: "prompt",
				scope: "session",
				tokens: section.tokens,
				state: "enabled" as const,
				reasons: [`${Math.round((section.tokens / Math.max(1, audit.promptTokens)) * 100)}%`],
			})),
		].sort((a, b) => b.tokens - a.tokens);
	}

	function toolRows(audit: AuditResult): Row[] {
		const active = new Set(pi.getActiveTools());
		const baseline = new Set(baselineTools);
		return pi
			.getAllTools()
			.filter((tool) => tool.exposure === "direct")
			.map((tool) => {
				const on = active.has(tool.name);
				return {
					kind: "tool" as const,
					id: `tool:${tool.name}`,
					name: tool.name,
					description: tool.description,
					source: tool.sourceInfo.source,
					scope: tool.sourceInfo.scope,
					tokens: audit.toolCosts[tool.name] ?? 0,
					state: on ? ("enabled" as const) : baseline.has(tool.name) ? ("disabled" as const) : ("forced" as const),
					reason: on ? "in the prompt" : baseline.has(tool.name) ? "turned off this session" : "not active at startup",
					path: tool.sourceInfo.path,
				};
			})
			.sort((a, b) => b.tokens - a.tokens);
	}

	function fileRows(audit: AuditResult): Row[] {
		return audit.projectFiles.map((file) => ({
			kind: "section" as const,
			id: `file:${file.path}`,
			name: basename(file.path),
			description: file.path,
			source: "context",
			scope: "project",
			tokens: file.tokens,
			state: "enabled" as const,
			path: file.path,
		}));
	}

	function buildTabs(mode: ManagerModel["mode"], audit: AuditResult | undefined): Tab[] {
		if (mode === "audit" && audit) {
			const tabs: Tab[] = [
				{ id: "sections", title: "Sections", rows: sectionRows(audit) },
				{ id: "tools", title: "Tools", rows: toolRows(audit) },
				{ id: "skills", title: "Skills", rows: inventory().skills },
			];
			if (audit.projectFiles.length > 0) tabs.push({ id: "files", title: "Context files", rows: fileRows(audit) });
			return tabs;
		}

		const inv = inventory();
		if (mode === "suggest") {
			const rows = [...inv.skills, ...inv.plugins, ...inv.catalog];
			return [
				{
					id: "recommended",
					title: "Recommended",
					rows: signals ? rankRows(rows, signals, 25) : rows,
				},
			];
		}

		const tabs: Tab[] = [
			{ id: "skills", title: "Skills", rows: inv.skills },
			{ id: "plugins", title: "Plugins", rows: inv.plugins },
		];
		if (inv.catalog.length > 0) tabs.push({ id: "catalog", title: "Installable", rows: inv.catalog });
		return tabs;
	}

	async function fetchLiveCatalog(): Promise<CatalogEntry[]> {
		const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(8000) });
		if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
		const payload = (await response.json()) as {
			objects?: Array<{ package?: { name?: string; description?: string; keywords?: string[] } }>;
		};
		return (payload.objects ?? [])
			.map((item) => item.package)
			.filter((pkg): pkg is { name: string; description?: string; keywords?: string[] } => Boolean(pkg?.name))
			.map((pkg) => ({
				id: `npm:${pkg.name}`,
				kind: "plugin" as const,
				name: pkg.name,
				description: pkg.description ?? "",
				keywords: pkg.keywords ?? [],
				install: `pi install npm:${pkg.name}`,
			}));
	}

	/** Exactly the text Pi injects for a row: skill block, tool declaration, or context file. */
	function previewForRow(row: Row, audit: AuditResult | undefined): string | undefined {
		if (row.kind === "skill") {
			const skill = cachedSkills.find((entry) => skillRowId(entry) === row.id);
			if (!skill) return undefined;
			const header = `# skills section entry (${row.tokens} tokens in the prompt)`;
			const note = skill.disableModelInvocation
				? `# not advertised to the model; reachable via /skill:${skill.name} only`
				: "";
			return [header, note, skillBlock(skill)].filter(Boolean).join("\n");
		}

		if (row.kind === "tool") {
			const tool = pi.getAllTools().find((entry) => `tool:${entry.name}` === row.id);
			if (!tool) return undefined;
			return [
				"# tools-section snippet",
				`- ${tool.name}: ${tool.description.split("\n")[0]}`,
				"",
				`# tool declaration sent next to the system prompt (${row.tokens} tokens)`,
				previewDeclaration(tool),
			].join("\n");
		}

		if (row.kind === "plugin") {
			const toolNames = row.toolNames ?? [];
			const tools = pi.getAllTools().filter((tool) => toolNames.includes(tool.name));
			const blocks: string[] = [];
			if (tools.length > 0) {
				blocks.push(`# ${tools.length} tool declarations (${row.tokens} tokens incl. this package's skills)`);
				for (const tool of tools) {
					blocks.push(
						`// ${tool.name}\n${previewDeclaration(tool)}`,
					);
				}
			}
			const skills = cachedSkills.filter(
				(skill) => skill.sourceInfo.source === row.source && !skill.disableModelInvocation,
			);
			if (skills.length > 0) {
				blocks.push("", "# skills section entries");
				for (const skill of skills) blocks.push(skillBlock(skill));
			}
			return blocks.length > 0 ? blocks.join("\n\n") : undefined;
		}

		if (row.kind === "section") {
			if (row.source === "context" && row.path) {
				try {
					return `# project context file: ${row.path} (${row.tokens} tokens)\n\n${readFileSync(row.path, "utf-8")}`;
				} catch {
					return `# ${row.path}\n\n(unreadable now)`;
				}
			}
			if (row.id === "section:preamble") return audit?.preamble;
			const name = row.id.replace(/^section:/, "");
			const section = audit?.sections.find((entry) => entry.name === name);
			return section ? `<${name}>\n${section.text}\n</${name}>` : undefined;
		}

		return undefined;
	}

	interface McpConfigLike {
		url?: string;
		command?: string;
		exposure?: string;
		enabled?: boolean;
	}

	/** Command name or URL host only: arguments, headers and env can hold credentials. */
	function mcpTransport(config: McpConfigLike): string {
		if (typeof config.url === "string" && config.url) {
			try {
				return `http ${new URL(config.url).host}`;
			} catch {
				return "http (unparseable url)";
			}
		}
		if (typeof config.command === "string" && config.command) return `stdio ${basename(config.command)}`;
		return "(defined by an override)";
	}

	function collectMcp(ctx: ExtensionContext): ReportMcpServer[] {
		const servers = new Map<string, ReportMcpServer>();
		for (const server of pi.getMcpServers()) {
			const config = server.config as McpConfigLike;
			servers.set(server.name, {
				name: server.name,
				scope: "extension",
				transport: mcpTransport(config),
				exposure: `${config.exposure ?? "default"}${config.enabled === false ? " · disabled" : ""}`,
				registered: true,
			});
		}

		const files: Array<[string, string]> = [[join(getAgentDir(), "mcp.json"), "global"]];
		if (ctx.isProjectTrusted()) files.push([join(ctx.cwd, CONFIG_DIR_NAME, "mcp.json"), "project"]);
		for (const [file, scope] of files) {
			const parsed = readJson<{ mcpServers?: Record<string, McpConfigLike> }>(file);
			for (const [name, config] of Object.entries(parsed?.mcpServers ?? {})) {
				servers.set(name, {
					name,
					scope,
					transport: mcpTransport(config),
					exposure: `${config.exposure ?? "default"}${config.enabled === false ? " · disabled" : ""}`,
					registered: servers.get(name)?.registered ?? false,
				});
			}
		}

		return [...servers.values()].sort((a, b) => a.name.localeCompare(b.name));
	}

	async function writeReport(ctx: ExtensionContext, target?: string): Promise<{ path: string; text: string }> {
		skillsFrom(ctx);
		const prompt = ctx.getSystemPrompt() ?? "";
		const audit = prompt ? buildAudit(prompt, cachedSkills) : undefined;
		const inv = inventory();
		const activeTools = new Set(pi.getActiveTools());
		const allTools = pi.getAllTools();
		const declarationTokens = (tool: (typeof allTools)[number]): number =>
			audit?.toolCosts[tool.name] ??
			toolDeclarationTokens({
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
				promptGuidelines: tool.promptGuidelines,
				exposure: tool.exposure,
			});

		// MCP tools are registered as `builtin:mcp`; they belong to their server, not to Pi.
		const mcpToolList = allTools.filter((tool) => tool.sourceInfo.path === "builtin:mcp");
		const mcp = collectMcp(ctx).map((server) => {
			const prefix = `mcp__${server.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}__`;
			const own = mcpToolList.filter((tool) => tool.name.toLowerCase().startsWith(prefix));
			return {
				...server,
				tools: own.length,
				tokens: own.reduce((sum, tool) => sum + declarationTokens(tool), 0),
			};
		});

		const builtinTools = allTools
			.filter((tool) => tool.sourceInfo.source === "builtin" && tool.sourceInfo.path !== "builtin:mcp")
			.map((tool) => ({
				name: tool.name,
				exposure: tool.exposure,
				active: activeTools.has(tool.name),
				tokens: declarationTokens(tool),
				source: tool.sourceInfo.path,
			}));

		const data: ReportData = {
			generatedAt: new Date().toISOString(),
			piVersion: VERSION,
			cwd: ctx.cwd,
			sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			thinking: ctx.thinkingLevel,
			tokenizer: tokenizerName(),
			prompt: {
				systemTokens: audit?.promptTokens ?? 0,
				toolTokens: audit?.activeToolTokens ?? 0,
				projectedTokens: audit?.projectedTokens ?? 0,
				savings: audit?.savings ?? 0,
				estimatedTokens: audit?.estimatedTokens ?? 0,
				sections: audit
					? [
							{ name: "preamble", tokens: audit.preambleTokens },
							...audit.sections.map((section) => ({ name: section.name, tokens: section.tokens })),
						]
					: [],
			},
			skills: inv.skills,
			plugins: inv.plugins,
			builtinTools,
			mcp,
			commands: pi
				.getCommands()
				.filter((command) => command.source !== "skill")
				.map((command) => ({
					name: command.name,
					source: command.sourceInfo.source,
					description: command.description,
				})),
			contextFiles: audit?.projectFiles ?? [],
			themes: ctx.mode === "tui" ? ctx.ui.getAllThemes().map((theme) => theme.name) : undefined,
			scopedModels:
				ctx.scopedModels.length > 0
					? ctx.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)
					: undefined,
			state: { disabledSkills: [...state.disabledSkills], disabledTools: [...state.disabledTools] },
		};

		const text = renderReport(data);
		const path = target ?? join(ctx.cwd, "pi-installation-report.md");
		writeFileSync(path, text, "utf-8");
		return { path, text };
	}

	async function openManager(ctx: ExtensionContext, mode: ManagerModel["mode"], prompt: string | undefined): Promise<void> {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("skill-manager needs interactive mode", "error");
			return;
		}

		const auditPromptText = prompt ?? lastBaselinePrompt;
		const auditNow = () => (auditPromptText ? buildAudit(auditPromptText, cachedSkills) : undefined);
		let audit = auditNow();
		let tabs = buildTabs(mode, audit);
		const model: ManagerModel = {
			mode,
			get tabs() {
				return tabs;
			},
			set tabs(next) {
				tabs = next;
			},
			get audit() {
				return audit;
			},
			tokenizer: tokenizerName(),
			get signalsSummary() {
				return signals ? summarizeSignals(signals) : undefined;
			},
			rebuild: () => {
				audit = auditNow();
				tabs = buildTabs(mode, audit);
				return tabs;
			},
		};

		const close = () => {
			applyToolState();
			persist();
			audit = auditNow();
			updateStatus(ctx, audit);
		};

		await ctx.ui.custom<undefined>(
			(tui, theme, keybindings, done) =>
				new ManagerComponent(
					tui,
					theme,
					keybindings,
					model,
					{
						toggle: (row) => {
							if (row.toggle === "skill") state = toggleSkill(state, row.id);
							else if (row.toggle === "plugin") state = toggleTools(state, row.toolNames ?? []);
							applyToolState();
						},
						copy: (text) => {
							void copyToClipboard(text).catch(() => undefined);
						},
						preview: (row) => previewForRow(row, audit),
						report: () => writeReport(ctx),
						refreshCatalog: async () => {
							liveCatalog = await fetchLiveCatalog();
						},
						done: close,
					},
					done,
				),
			{ blocked: { kind: "question", message: "Choose skills and plugins" } },
		);
	}

	async function collectSignals(ctx: ExtensionContext, extraTerms: string[]): Promise<Signals> {
		let gitPaths: string[] = [];
		try {
			const result = await pi.exec("git", ["status", "--short"], { cwd: ctx.cwd, timeout: 4000 });
			if (result.code === 0) {
				gitPaths = result.stdout
					.split("\n")
					.map((line) => line.slice(3).trim())
					.filter(Boolean);
			}
		} catch {
			gitPaths = [];
		}
		const snapshot = await scanProject(ctx.cwd, gitPaths);
		return buildSignals(snapshot, extraTerms);
	}

	function rankedRows(limit = 25): ScoredRow[] {
		const inv = inventory();
		const rows = [...inv.skills, ...inv.plugins, ...inv.catalog];
		return signals ? rankRows(rows, signals, limit) : rows.map((row) => ({ ...row, score: 0, reasons: row.reasons ?? [] }));
	}

	// ---------------------------------------------------------------------------
	// Session lifecycle
	// ---------------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Union, not replace: a `/new` or reload must keep tools that the first capture saw,
		// otherwise a tool this session switched off could never be switched back on.
		baselineTools = [...new Set([...baselineTools, ...pi.getActiveTools()])];
		state = restoreState(ctx.sessionManager.getBranch());
		config = loadConfig();
		applyToolState();
		const prompt = ctx.getSystemPrompt();
		if (prompt) lastBaselinePrompt = prompt;
		updateStatus(ctx, prompt ? buildAudit(prompt, cachedSkills) : undefined);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const options = event.systemPromptOptions as PromptOptionsLike;
		const allSkills = options.skills ?? [];
		// Read the prompt before filtering so the audit keeps the unfiltered baseline.
		const baselinePrompt = event.systemPrompt;
		options.skills = allSkills.filter(
			(skill) => skill.disableModelInvocation || !state.disabledSkills.includes(skillRowId(skill)),
		);
		cachedSkills = allSkills;
		lastBaselinePrompt = baselinePrompt;
		updateStatus(ctx, buildAudit(baselinePrompt, allSkills));
	});

	// ---------------------------------------------------------------------------
	// Commands
	// ---------------------------------------------------------------------------

	pi.registerCommand("prompt-tokens", {
		description: "Token audit of the assembled system prompt, skills and tool declarations",
		handler: async (_args, ctx) => {
			const prompt = ctx.getSystemPrompt();
			if (!prompt) {
				ctx.ui.notify("No system prompt available", "error");
				return;
			}
			skillsFrom(ctx);
			await openManager(ctx, "audit", prompt);
		},
	});

	pi.registerCommand("resources", {
		description: "Turn skills and plugins on or off for this session",
		handler: async (_args, ctx) => {
			skillsFrom(ctx);
			await openManager(ctx, "manage", ctx.getSystemPrompt());
		},
	});

	pi.registerCommand("report", {
		description: "Write a Markdown report of this Pi installation (skills, plugins, tools, MCP, commands)",
		handler: async (args, ctx) => {
			const target = args.trim() ? resolve(ctx.cwd, args.trim()) : undefined;
			try {
				const { path, text } = await writeReport(ctx, target);
				const lines = text.split("\n").length;
				ctx.ui.notify(`Pi report: ${path} (${lines} lines)`, "info");
			} catch (error) {
				ctx.ui.notify(`Report failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("pick", {
		description: "Analyze this project and suggest skills/plugins to enable",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("skill-manager needs interactive mode", "error");
				return;
			}
			skillsFrom(ctx);
			signals = await collectSignals(ctx, args.trim() ? [args.trim()] : []);
			await openManager(ctx, "suggest", ctx.getSystemPrompt());
		},
	});

	// ---------------------------------------------------------------------------
	// Tool
	// ---------------------------------------------------------------------------

	pi.registerTool({
		name: "suggest_resources",
		label: "Suggest skills/plugins",
		description:
			"Analyze this project (manifests, dependencies, file types, git changes) and rank installed skills, installed plugins and installable packages worth enabling. In interactive mode it opens a picker so the user can accept suggestions; otherwise it returns the ranked list.",
		parameters: Type.Object({
			focus: Type.Optional(
				Type.String({ description: "What the current job is about; used as extra ranking terms." }),
			),
			limit: Type.Optional(Type.Number({ description: "Maximum suggestions to return (default 10)." })),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
			const focus = typeof params.focus === "string" ? params.focus : "";
			const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(25, params.limit) : 10;
			signals = await collectSignals(ctx, focus ? [focus] : []);
			const summary = summarizeSignals(signals);

			if (ctx.mode === "tui") {
				await openManager(ctx, "suggest", lastBaselinePrompt ?? ctx.getSystemPrompt());
				return {
					content: [
						{
							type: "text",
							text: [
								"Session resources updated from the picker.",
								`Disabled skills: ${state.disabledSkills.join(", ") || "none"}`,
								`Disabled tools: ${state.disabledTools.join(", ") || "none"}`,
								summary ? `Project signals: ${summary}` : "",
							]
								.filter(Boolean)
								.join("\n"),
						},
					],
					details: {
						disabledSkills: state.disabledSkills.length,
						disabledTools: state.disabledTools.length,
					},
				};
			}

			const ranked = rankedRows(limit);
			const text =
				ranked.length === 0
					? "No skills or plugins scored above zero for this project."
					: [
							`Top ${ranked.length} suggestions${summary ? ` (${summary})` : ""}:`,
							...ranked.map((row, index) => {
								const price = row.tokens > 0 ? `${formatTokens(row.tokens)} prompt tokens` : "no prompt cost";
								const install = row.state === "available" ? `; install: ${row.install}` : "";
								const matches = row.reasons.length > 0 ? `; matches ${row.reasons.join(", ")}` : "";
								return `${index + 1}. [${row.kind}/${row.state}] ${row.name} — ${price}${matches}${install}`;
							}),
						].join("\n");

			return { content: [{ type: "text", text }], details: { summary, count: ranked.length } };
		},
	});
}
