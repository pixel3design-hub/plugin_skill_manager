/**
 * Project analysis and deterministic ranking.
 *
 * Cheap on purpose: the TUI needs a defensible ordering, not a second model call.
 * The `suggest_resources` tool hands the ranked rows to the model, which can then
 * apply its own judgment.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, basename, extname } from "node:path";
import type { Row } from "./model.ts";

const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	"dist",
	"build",
	"out",
	"target",
	".venv",
	"venv",
	"__pycache__",
	".next",
	".turbo",
	".cache",
	"vendor",
	"coverage",
]);

const MANIFESTS = [
	"package.json",
	"pyproject.toml",
	"requirements.txt",
	"go.mod",
	"Cargo.toml",
	"Gemfile",
	"composer.json",
	"pubspec.yaml",
	"Makefile",
	"docker-compose.yml",
	"Dockerfile",
];

const STOPWORDS = new Set(
	`a an and are as at be been but by can could do does for from has have how if in into is it its may might more
	most must no not of on or other our out over per should so some such than that the their them then there these
	they this those to under up use used using via was we were what when where which while who will with within
	without you your skill skills tool tools plugin plugins extension extensions package packages pi help helps
	specialized instructions specific tasks task when work working file files project code user users new get set
	load loads`.split(/\s+/),
);

export interface ProjectSnapshot {
	manifests: Array<{ path: string; content: string }>;
	files: string[];
	dirs: string[];
	readme: string;
	gitPaths: string[];
}

export interface Signals {
	weights: Map<string, number>;
	summary: string[];
}

const WEIGHT = {
	prompt: 6,
	dependency: 4,
	manifest: 3,
	extension: 2,
	dir: 2,
	readme: 1,
	git: 1,
} as const;

export function addTerms(signals: Signals, text: string, weight: number): void {
	for (const term of tokenize(text)) {
		const current = signals.weights.get(term) ?? 0;
		if (weight > current) signals.weights.set(term, weight);
	}
}

export function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9+#]+/)
		.map((part) => part.trim())
		.filter((term) => term.length >= 3 && !STOPWORDS.has(term) && !/^\d+$/.test(term));
}

function readIfExists(path: string, limit = Number.POSITIVE_INFINITY): string | undefined {
	try {
		const content = readFileSync(path, "utf-8");
		return content.length > limit ? content.slice(0, limit) : content;
	} catch {
		return undefined;
	}
}

function walk(
	root: string,
	options: { maxFiles: number; maxDepth: number },
): { files: string[]; dirs: string[] } {
	const files: string[] = [];
	const dirs: string[] = [];
	const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

	while (queue.length > 0 && files.length < options.maxFiles) {
		const { dir, depth } = queue.shift()!;
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (entry.startsWith(".") && entry !== ".github") continue;
			const full = join(dir, entry);
			let isDir = false;
			try {
				isDir = statSync(full).isDirectory();
			} catch {
				continue;
			}
			if (isDir) {
				if (SKIP_DIRS.has(entry)) continue;
				const rel = relative(root, full);
				if (depth === 0) dirs.push(rel);
				if (depth + 1 <= options.maxDepth) queue.push({ dir: full, depth: depth + 1 });
				continue;
			}
			files.push(relative(root, full));
			if (files.length >= options.maxFiles) break;
		}
	}

	return { files, dirs };
}

export async function scanProject(
	cwd: string,
	gitPaths?: string[],
	options: { maxFiles?: number; maxDepth?: number } = {},
): Promise<ProjectSnapshot> {
	const manifests: Array<{ path: string; content: string }> = [];
	for (const name of MANIFESTS) {
		const content = readIfExists(join(cwd, name));
		if (content !== undefined) manifests.push({ path: name, content });
	}
	// Language manifests with variable names, one level deep.
	for (const name of readdirSafe(cwd)) {
		if (/\.(csproj|fsproj|sln|gradle)$/.test(name)) {
			const content = readIfExists(join(cwd, name), 4000);
			if (content !== undefined) manifests.push({ path: name, content });
		}
	}

	const { files, dirs } = walk(cwd, {
		maxFiles: options.maxFiles ?? 4000,
		maxDepth: options.maxDepth ?? 5,
	});
	const readmeName = readdirSafe(cwd).find((name) => /^readme(\.[a-z]+)?$/i.test(name));
	const readme = (readmeName && readIfExists(join(cwd, readmeName), 2000)) || "";

	return { manifests, files, dirs, readme, gitPaths: gitPaths ?? [] };
}

function readdirSafe(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function dependenciesFromManifest(path: string, content: string): string[] {
	const deps: string[] = [];
	const name = basename(path);
	if (name === "package.json") {
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
				const block = parsed[field];
				if (block && typeof block === "object") deps.push(...Object.keys(block as Record<string, unknown>));
			}
			if (Array.isArray(parsed.keywords)) deps.push(...parsed.keywords.filter((k): k is string => typeof k === "string"));
			if (typeof parsed.name === "string") deps.push(parsed.name);
		} catch {
			// Malformed package.json: the file-type census still carries signal.
		}
		return deps;
	}
	if (name === "requirements.txt") {
		for (const line of content.split("\n")) {
			const dep = line.split(/[=<>!~[;#]/)[0]?.trim();
			if (dep) deps.push(dep);
		}
		return deps;
	}
	if (name === "go.mod") {
		for (const match of content.matchAll(/^\s*(?:require\s+)?([\w.-]+\/[\w./-]+)\s+v\d/gm)) {
			if (match[1]) deps.push(match[1].split("/").pop()!);
		}
		return deps;
	}
	if (name === "Cargo.toml" || name === "pyproject.toml") {
		for (const match of content.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)) {
			if (match[1]) deps.push(match[1]);
		}
		return deps;
	}
	if (name === "Gemfile") {
		for (const match of content.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)) {
			if (match[1]) deps.push(match[1]);
		}
		return deps;
	}
	if (name === "composer.json") {
		try {
			const parsed = JSON.parse(content) as Record<string, unknown>;
			for (const field of ["require", "require-dev"]) {
				const block = parsed[field];
				if (block && typeof block === "object") deps.push(...Object.keys(block as Record<string, unknown>));
			}
		} catch {
			// ignore
		}
	}
	return deps;
}

export function buildSignals(snapshot: ProjectSnapshot, extraTerms: string[] = []): Signals {
	const signals: Signals = { weights: new Map(), summary: [] };

	for (const term of extraTerms) addTerms(signals, term, WEIGHT.prompt);

	const dependencyNames: string[] = [];
	for (const manifest of snapshot.manifests) {
		addTerms(signals, manifest.path.replace(/\.[^.]+$/, ""), WEIGHT.manifest);
		const deps = dependenciesFromManifest(manifest.path, manifest.content);
		dependencyNames.push(...deps);
		for (const dep of deps) {
			addTerms(signals, dep, WEIGHT.dependency);
			addTerms(signals, dep.replace(/^@[^/]+\//, ""), WEIGHT.dependency);
		}
	}

	const extensionCounts = new Map<string, number>();
	for (const file of snapshot.files) {
		const ext = extname(file).replace(/^\./, "");
		if (ext) extensionCounts.set(ext, (extensionCounts.get(ext) ?? 0) + 1);
	}
	const topExtensions = [...extensionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
	for (const [ext] of topExtensions) addTerms(signals, ext, WEIGHT.extension);

	for (const dir of snapshot.dirs.slice(0, 20)) addTerms(signals, dir, WEIGHT.dir);
	addTerms(signals, snapshot.readme, WEIGHT.readme);
	for (const path of snapshot.gitPaths.slice(0, 40)) addTerms(signals, path, WEIGHT.git);

	signals.summary = [
		dependencyNames.length > 0 ? `${dependencyNames.length} deps` : "",
		topExtensions.length > 0 ? topExtensions.slice(0, 5).map(([ext]) => `.${ext}`).join(" ") : "",
		snapshot.files.length > 0 ? `${snapshot.files.length} files` : "",
		snapshot.gitPaths.length > 0 ? `${snapshot.gitPaths.length} changed paths` : "",
	].filter(Boolean);

	return signals;
}

function entryTerms(row: Row): string[] {
	const parts = [row.name, row.description, ...(row.reasons ?? [])];
	return [...new Set(parts.flatMap((part) => tokenize(part)))];
}

export interface ScoredRow extends Row {
	score: number;
	reasons: string[];
}

export function scoreRow(row: Row, signals: Signals): ScoredRow {
	const terms = entryTerms(row);
	const matches: Array<{ term: string; weight: number }> = [];
	let total = 0;
	for (const term of terms) {
		const weight = signals.weights.get(term);
		if (!weight) continue;
		total += weight;
		matches.push({ term, weight });
	}
	const score = total === 0 ? 0 : total / Math.sqrt(Math.max(1, terms.length));
	matches.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
	return { ...row, score, reasons: matches.slice(0, 3).map((match) => match.term) };
}

/** Ranked suggestion list: installed resources stay visible, forced ones never are. */
export function rankRows(rows: Row[], signals: Signals, limit = 10): ScoredRow[] {
	return rows
		.filter((row) => row.state !== "forced")
		.map((row) => scoreRow(row, signals))
		.filter((row) => row.score > 0)
		.sort((a, b) => b.score - a.score || a.tokens - b.tokens || a.name.localeCompare(b.name))
		.slice(0, limit);
}

export function summarizeSignals(signals: Signals): string {
	return signals.summary.join(" · ");
}
