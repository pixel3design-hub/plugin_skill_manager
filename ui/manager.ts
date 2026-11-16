/**
 * One custom Pi component for all three screens.
 *
 * Colour contract:
 *   enabled   green background
 *   forced    red background   (cannot be turned on in this session)
 *   available yellow background (not installed, recommended)
 *   disabled  default background (turned off for this session)
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	type KeybindingsManager,
	matchesKey,
	indexedColor,
	truncateToWidth,
	visibleWidth,
	type TUI,
} from "@earendil-works/pi-tui";
import type { Row, RowState } from "../lib/model.ts";
import type { AuditResult } from "../lib/tokens.ts";

export type ManagerMode = "audit" | "manage" | "suggest";

export interface Tab {
	id: string;
	title: string;
	rows: Row[];
}

export interface ManagerActions {
	/** Toggle a skill or plugin; the host rebuilds `tabs` and calls `refresh`. */
	toggle(row: Row): void;
	refreshCatalog?(): Promise<void>;
	/** Writes the installation report and returns its path and text. */
	report?(): Promise<{ path: string; text: string }>;
	copy?(text: string): void;
	/** Text Pi injects into the prompt for this row (skill block, tool declaration, context file). */
	preview?(row: Row): string | undefined;
	done(): void;
}

export interface ManagerModel {
	mode: ManagerMode;
	tabs: Tab[];
	audit?: AuditResult;
	tokenizer: string;
	signalsSummary?: string;
	/** Returns freshly built tabs after a toggle or catalog refresh. */
	rebuild(): Tab[];
}

const MAX_ROWS = 14;
const MAX_PREVIEW_LINES = 18;
const HINTS: Record<ManagerMode, string> = {
	audit: "↑↓ move · tab switch · p preview · r report · s sort · d details · esc close",
	manage: "space toggle · ↑↓ move · tab switch · / filter · p preview · r report · s sort · d details · esc close",
	suggest: "space accept · A accept all · i copy install · c refresh catalog · p preview · r report · / filter · esc close",
};

const TITLES: Record<ManagerMode, string> = {
	audit: "Prompt audit",
	manage: "Skills & plugins",
	suggest: "Recommended for this project",
};

function formatTokens(tokens: number): string {
	if (tokens >= 10000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

function pad(text: string, width: number): string {
	const truncated = truncateToWidth(text, width);
	const remaining = width - visibleWidth(truncated);
	return remaining > 0 ? truncated + " ".repeat(remaining) : truncated;
}

export class ManagerComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly model: ManagerModel;
	private readonly actions: ManagerActions;
	private readonly finish: (result: undefined) => void;

	private tabIndex = 0;
	private selectedId: string | undefined;
	private filter = "";
	private filterActive = false;
	private sortMode: "tokens" | "name" = "tokens";
	private showDetails = false;
	private refreshing = false;
	private reporting = false;
	private message: string | undefined;
	private preview: { title: string; lines: string[]; offset: number } | undefined;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		model: ManagerModel,
		actions: ManagerActions,
		finish: (result: undefined) => void,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.model = model;
		this.actions = actions;
		this.finish = finish;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	private get tabs(): Tab[] {
		return this.model.tabs;
	}

	private get tab(): Tab {
		return this.tabs[Math.min(this.tabIndex, this.tabs.length - 1)] ?? { id: "empty", title: "Empty", rows: [] };
	}

	private get rows(): Row[] {
		const filtered = this.filter
			? this.tab.rows.filter((row) => {
					const haystack = `${row.name} ${row.description} ${row.source} ${(row.reasons ?? []).join(" ")}`.toLowerCase();
					return haystack.includes(this.filter.toLowerCase());
				})
			: [...this.tab.rows];
		return filtered.sort((a, b) =>
			this.sortMode === "tokens" ? b.tokens - a.tokens || a.name.localeCompare(b.name) : a.name.localeCompare(b.name),
		);
	}

	private get selectedIndex(): number {
		const rows = this.rows;
		if (rows.length === 0) return 0;
		const index = this.selectedId ? rows.findIndex((row) => row.id === this.selectedId) : -1;
		return index >= 0 ? index : Math.min(this.windowStart, rows.length - 1);
	}

	private windowStart = 0;

	private get selectedRow(): Row | undefined {
		return this.rows[this.selectedIndex];
	}

	private move(delta: number): void {
		const rows = this.rows;
		if (rows.length === 0) return;
		const next = Math.max(0, Math.min(rows.length - 1, this.selectedIndex + delta));
		this.selectedId = rows[next]?.id;
		if (next < this.windowStart) this.windowStart = next;
		if (next >= this.windowStart + MAX_ROWS) this.windowStart = next - MAX_ROWS + 1;
	}

	private rebuildTabs(): void {
		this.model.tabs = this.model.rebuild();
		this.invalidate();
		this.tui.requestRender();
	}

	private toggleSelected(): void {
		const row = this.selectedRow;
		if (!row) return;
		if (row.kind === "catalog") {
			if (row.install) {
				this.actions.copy?.(row.install);
				this.message = `copied: ${row.install}`;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		if (!row.toggle) {
			this.message = row.state === "forced" ? "locked: enable it in settings, then /reload" : "nothing to toggle";
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		this.actions.toggle(row);
		this.selectedId = row.id;
		this.message = undefined;
		this.rebuildTabs();
	}

	private openPreview(): void {
		const row = this.selectedRow;
		if (!row) return;
		const text = this.actions.preview?.(row);
		if (!text) {
			this.message = row.kind === "catalog" ? "nothing injected yet — install it first" : "no injected text for this row";
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		this.message = undefined;
		this.preview = {
			title: `${row.name} · ${row.kind} · ${formatTokens(row.tokens)} tokens`,
			lines: text.replace(/\n+$/, "").split("\n"),
			offset: 0,
		};
		this.invalidate();
		this.tui.requestRender();
	}

	private acceptAll(): void {
		for (const row of this.rows) {
			if (row.kind === "catalog" || !row.toggle || row.state === "enabled" || row.state === "forced") continue;
			this.actions.toggle(row);
		}
		this.rebuildTabs();
	}

	handleInput(data: string): void {
		if (this.preview) {
			const preview = this.preview;
			if (matchesKey(data, "p") || matchesKey(data, Key.escape)) {
				this.preview = undefined;
			} else {
				if (matchesKey(data, Key.up) || matchesKey(data, "k")) preview.offset -= 1;
				else if (matchesKey(data, Key.down) || matchesKey(data, "j")) preview.offset += 1;
				else if (matchesKey(data, Key.pageUp)) preview.offset -= MAX_PREVIEW_LINES;
				else if (matchesKey(data, Key.pageDown)) preview.offset += MAX_PREVIEW_LINES;
				else if (matchesKey(data, Key.home)) preview.offset = 0;
				else if (matchesKey(data, Key.end)) preview.offset = preview.lines.length;
				else return;
				const max = Math.max(0, preview.lines.length - MAX_PREVIEW_LINES);
				preview.offset = Math.max(0, Math.min(max, preview.offset));
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (this.filterActive) {
			if (matchesKey(data, Key.enter)) {
				this.filterActive = false;
				this.windowStart = 0;
			} else if (matchesKey(data, Key.escape)) {
				this.filterActive = false;
				this.filter = "";
				this.windowStart = 0;
			} else if (matchesKey(data, Key.backspace)) {
				this.filter = this.filter.slice(0, -1);
				this.windowStart = 0;
			} else if (matchesKey(data, Key.space)) {
				this.filter += " ";
				this.windowStart = 0;
			} else if (data.length === 1 && data >= " " && data !== "\x7f") {
				this.filter += data;
				this.windowStart = 0;
			} else {
				return;
			}
			this.invalidate();
			this.tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, "q") || this.keybindings.matches(data, "tui.select.cancel")) {
			this.actions.done();
			this.finish(undefined);
			return;
		}
		if (matchesKey(data, Key.up) || matchesKey(data, "k")) this.move(-1);
		else if (matchesKey(data, Key.down) || matchesKey(data, "j")) this.move(1);
		else if (matchesKey(data, Key.pageUp)) this.move(-MAX_ROWS);
		else if (matchesKey(data, Key.pageDown)) this.move(MAX_ROWS);
		else if (matchesKey(data, Key.tab)) {
			this.tabIndex = (this.tabIndex + 1) % Math.max(1, this.tabs.length);
			this.selectedId = undefined;
			this.windowStart = 0;
		} else if (data === "1" || data === "2" || data === "3") {
			const index = Number(data) - 1;
			if (index < this.tabs.length) {
				this.tabIndex = index;
				this.selectedId = undefined;
				this.windowStart = 0;
			}
		} else if (matchesKey(data, "/")) {
			this.filterActive = true;
			this.filter = "";
		} else if (matchesKey(data, "s")) {
			this.sortMode = this.sortMode === "tokens" ? "name" : "tokens";
		} else if (matchesKey(data, "d")) {
			this.showDetails = !this.showDetails;
		} else if (matchesKey(data, "p")) {
			this.openPreview();
		} else if (matchesKey(data, Key.space) || matchesKey(data, Key.enter)) {
			this.toggleSelected();
		} else if (matchesKey(data, "shift+a")) {
			this.acceptAll();
		} else if (matchesKey(data, "i")) {
			const row = this.selectedRow;
			if (row?.install) {
				this.actions.copy?.(row.install);
				this.message = `copied: ${row.install}`;
			}
		} else if (matchesKey(data, "r")) {
			if (this.actions.report && !this.reporting) {
				this.reporting = true;
				this.message = "writing report…";
				void this.actions
					.report()
					.then((result) => {
						this.preview = {
							title: `report · ${result.path}`,
							lines: result.text.replace(/\n+$/, "").split("\n"),
							offset: 0,
						};
						this.message = `report written to ${result.path}`;
					})
					.catch((error: unknown) => {
						this.message = `report failed: ${error instanceof Error ? error.message : String(error)}`;
					})
					.finally(() => {
						this.reporting = false;
						this.invalidate();
						this.tui.requestRender();
					});
			}
		} else if (matchesKey(data, "c")) {
			if (this.actions.refreshCatalog && !this.refreshing) {
				this.refreshing = true;
				this.message = "refreshing catalog from npm…";
				void this.actions
					.refreshCatalog()
					.catch((error: unknown) => {
						this.message = `catalog refresh failed: ${error instanceof Error ? error.message : String(error)}`;
					})
					.finally(() => {
						this.refreshing = false;
						if (this.message?.startsWith("refreshing catalog")) this.message = "catalog refreshed";
						this.rebuildTabs();
					});
			}
		} else {
			return;
		}

		this.invalidate();
		this.tui.requestRender();
	}

	private stateStyle(state: RowState, text: string, width: number): string {
		const dark = this.theme.appearance === "dark";
		const fg = indexedColor(dark ? 0 : 15);
		const padded = pad(text, width);
		switch (state) {
			case "enabled":
				return this.theme.style(padded, { bg: this.theme.colors.success, fg, bold: true });
			case "forced":
				return this.theme.style(padded, { bg: this.theme.colors.error, fg, bold: true });
			case "available":
				return this.theme.style(padded, { bg: this.theme.colors.warning, fg, bold: true });
			default:
				return this.theme.fg("dim", padded);
		}
	}

	private renderRow(row: Row, selected: boolean, width: number): string {
		const marker = selected ? "▸ " : "  ";
		const icon = row.state === "enabled" ? "●" : row.state === "disabled" ? "○" : row.state === "forced" ? "✕" : "+";

		if (row.kind === "section") {
			const share = row.reasons?.[0] ?? "";
			const barWidth = Math.max(0, Math.min(16, Math.round(row.tokens / Math.max(1, this.model.audit?.promptTokens ?? 1) * 16)));
			const bar = "█".repeat(barWidth) + "░".repeat(Math.max(0, 6 - barWidth));
			return this.theme.fg(selected ? "accent" : "text", truncateToWidth(`${marker}${pad(row.name, 18)} ${pad(formatTokens(row.tokens), 6)} ${bar} ${share}`, width));
		}

		const tokenLabel = row.tokens > 0 ? formatTokens(row.tokens) : row.score !== undefined ? `${(row.score * 10).toFixed(0)}` : "-";
		const detail =
			row.kind === "catalog"
				? row.install ?? ""
				: (row.reasons?.length ?? 0) > 0
					? row.reasons!.join(", ")
					: row.reason ?? row.source;
		const nameWidth = Math.min(38, Math.max(18, Math.floor(width * 0.4)));
		const text = `${marker}${icon} ${pad(row.name, nameWidth)} ${pad(tokenLabel, 6)} ${detail}`;

		if (row.state === "disabled" && selected) {
			return this.theme.style(pad(text, width), { bg: this.theme.colors.selectedBg, fg: this.theme.colors.searchMatchText });
		}
		if (row.state === "disabled") return this.theme.fg("muted", pad(text, width));
		return this.stateStyle(row.state, text, width);
	}

	private legendLine(width: number): string {
		const dark = this.theme.appearance === "dark";
		const fg = indexedColor(dark ? 0 : 15);
		const swatch = (label: string, style: { bg?: Parameters<Theme["style"]>[1]["bg"]; fg?: Parameters<Theme["style"]>[1]["fg"] }) =>
			this.theme.style(` ${label} `, style);
		const parts = [
			swatch("enabled", { bg: this.theme.colors.success, fg }),
			swatch("locked", { bg: this.theme.colors.error, fg }),
			swatch("recommended", { bg: this.theme.colors.warning, fg }),
			this.theme.fg("dim", " off "),
		];
		return truncateToWidth(parts.join(" "), width);
	}

	private renderPreview(width: number, preview: { title: string; lines: string[]; offset: number }): string[] {
		const lines: string[] = [];
		lines.push(this.theme.fg("accent", truncateToWidth(`Prompt text · ${preview.title}`, width)));
		lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))));
		const slice = preview.lines.slice(preview.offset, preview.offset + MAX_PREVIEW_LINES);
		const gutter = String(Math.max(1, preview.offset + slice.length)).length;
		slice.forEach((line, index) => {
			const number = String(preview.offset + index + 1).padStart(gutter);
			lines.push(truncateToWidth(`${this.theme.fg("dim", number)} ${line}`, width));
		});
		if (slice.length === 0) lines.push(this.theme.fg("dim", "(empty)"));
		const last = preview.offset + slice.length;
		lines.push(this.theme.fg("dim", truncateToWidth(`${preview.offset + 1}–${last} of ${preview.lines.length} · ${preview.title.split(" · ").pop()}`, width)));
		lines.push(this.theme.fg("dim", truncateToWidth("↑↓ / pgup / pgdn scroll · p or esc back", width)));
		return lines;
	}

	private headerLines(width: number): string[] {
		const lines: string[] = [];
		const audit = this.model.audit;
		lines.push(this.theme.fg("accent", truncateToWidth(TITLES[this.model.mode], width)));

		if (this.model.mode === "audit" && audit) {
			lines.push(
				this.theme.fg(
					"text",
					truncateToWidth(
						`prompt ${formatTokens(audit.promptTokens)} · tools ${formatTokens(audit.activeToolTokens)} · next request ${formatTokens(audit.projectedTokens)} · saves ${formatTokens(audit.savings)} · ${this.model.tokenizer}`,
						width,
					),
				),
			);
		} else {
			const rows = this.model.tabs.flatMap((tab) => tab.rows);
			const enabled = rows.filter((row) => row.state === "enabled").length;
			const disabled = rows.filter((row) => row.state === "disabled").length;
			const forced = rows.filter((row) => row.state === "forced").length;
			const parts = [`${enabled} enabled`, `${disabled} off`, `${forced} locked`];
			if (this.model.audit) parts.push(`next request ${formatTokens(this.model.audit.projectedTokens)}`);
			lines.push(this.theme.fg("text", truncateToWidth(parts.join(" · "), width)));
		}

		if (this.model.signalsSummary) {
			lines.push(this.theme.fg("dim", truncateToWidth(`project: ${this.model.signalsSummary}`, width)));
		}

		lines.push(this.legendLine(width));

		const tabLine = this.tabs
			.map((tab, index) => (index === this.tabIndex ? `[${tab.title} ${tab.rows.length}]` : ` ${tab.title} ${tab.rows.length} `))
			.join(" ");
		lines.push(this.theme.fg("accent", truncateToWidth(tabLine, width)));
		return lines;
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
		if (this.preview) {
			this.cachedWidth = width;
			this.cachedLines = this.renderPreview(width, this.preview);
			return this.cachedLines;
		}

		const rows = this.rows;
		const selected = this.selectedIndex;
		if (selected < this.windowStart) this.windowStart = selected;
		if (selected >= this.windowStart + MAX_ROWS) this.windowStart = selected - MAX_ROWS + 1;

		const lines = this.headerLines(width);
		lines.push(this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))));

		if (rows.length === 0) {
			lines.push(this.theme.fg("dim", truncateToWidth(this.filter ? `no match for "${this.filter}"` : "nothing here", width)));
		} else {
			const slice = rows.slice(this.windowStart, this.windowStart + MAX_ROWS);
			slice.forEach((row, offset) => {
				lines.push(this.renderRow(row, this.windowStart + offset === selected, width));
			});
		}

		const rangeEnd = Math.min(rows.length, this.windowStart + MAX_ROWS);
		lines.push(
			this.theme.fg(
				"dim",
				truncateToWidth(
					`${rows.length === 0 ? 0 : this.windowStart + 1}–${rangeEnd} of ${rows.length}${this.filter ? ` · filter "${this.filter}"` : ""} · sort ${this.sortMode}`,
					width,
				),
			),
		);

		if (this.filterActive) {
			lines.push(this.theme.fg("accent", truncateToWidth(`/${this.filter}▏`, width)));
		}
		if (this.message) lines.push(this.theme.fg("warning", truncateToWidth(this.message, width)));

		if (this.showDetails) {
			const row = this.selectedRow;
			if (row) {
				const details = [
					`${row.name} · ${row.kind} · ${row.state}${row.reason ? ` (${row.reason})` : ""}`,
					row.description,
					row.path ? `path: ${row.path}` : `source: ${row.source} · scope: ${row.scope}`,
					`prompt cost ${row.tokens}${row.fullTokens ? ` · loads ${row.fullTokens} when used` : ""}${row.toolNames?.length ? ` · tools: ${row.toolNames.join(", ")}` : ""}`,
					row.score !== undefined ? `score ${row.score.toFixed(1)}${row.reasons?.length ? ` · matches ${row.reasons.join(", ")}` : ""}` : "",
					row.install ? `install: ${row.install}` : "",
				].filter(Boolean);
				for (const line of details) lines.push(this.theme.fg("muted", truncateToWidth(line, width)));
			}
		}

		lines.push(this.theme.fg("dim", truncateToWidth(HINTS[this.model.mode], width)));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}
}
