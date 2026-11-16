import assert from "node:assert/strict";
import test from "node:test";
import type { Row } from "../lib/model.ts";
import { renderReport, type ReportData } from "../lib/report.ts";

function row(input: Partial<Row> & { name: string; kind: Row["kind"] }): Row {
	const { name, ...rest } = input;
	return {
		id: `${input.kind}:${name}`,
		name,
		description: "",
		source: "npm:demo",
		scope: "user",
		tokens: 100,
		state: "enabled",
		...rest,
	} as Row;
}

const data: ReportData = {
	generatedAt: "2026-11-17T00:00:00.000Z",
	piVersion: "1.5.2",
	cwd: "/repo",
	sessionFile: "/sessions/s1.jsonl",
	model: "deepseek/deepseek-flash",
	thinking: "high",
	tokenizer: "o200k",
	prompt: {
		systemTokens: 4020,
		toolTokens: 13000,
		projectedTokens: 15900,
		savings: 1114,
		estimatedTokens: 4200,
		sections: [
			{ name: "skills", tokens: 2352 },
			{ name: "rules", tokens: 927 },
		],
	},
	skills: [
		row({ kind: "skill", name: "court", tokens: 218, fullTokens: 1200, state: "enabled", source: "git:github.com/x/court" }),
		row({ kind: "skill", name: "hidden", tokens: 0, state: "forced", reason: "hidden from the model" }),
	],
	plugins: [
		row({
			kind: "plugin",
			name: "pi-memory",
			source: "npm:pi-memory",
			tokens: 1114,
			state: "disabled",
			toolNames: ["memory_write", "memory_search"],
		}),
	],
	builtinTools: [
		{ name: "read", exposure: "direct", active: true, tokens: 130, source: "builtin:read" },
		{ name: "codemode", exposure: "model-only", active: false, tokens: 90, source: "builtin:codemode" },
	],
	mcp: [
		{ name: "docs", scope: "global", transport: "http mcp.example.com", exposure: "direct", registered: true, tools: 3, tokens: 900 },
		{ name: "old", scope: "project", transport: "stdio npx", exposure: "default · disabled", registered: false },
	],
	commands: [
		{ name: "memory", source: "npm:pi-memory", description: "memory search" },
		{ name: "plan", source: "npm:@bacnh85/pi-plan" },
		{ name: "review", source: "user" },
	],
	contextFiles: [{ path: "/repo/AGENTS.md", tokens: 34 }],
	themes: ["dark", "system"],
	scopedModels: ["deepseek/deepseek-flash"],
	state: { disabledSkills: ["skill:court"], disabledTools: ["memory_write"] },
};

test("report has a metadata header, a summary and the prompt budget", () => {
	const text = renderReport(data);
	assert.match(text, /^# Pi installation report/);
	assert.match(text, /Pi 1\.5\.2/);
	assert.match(text, /deepseek\/deepseek-flash \(thinking high\)/);
	assert.match(text, /cwd `\/repo`/);
	assert.match(text, /System prompt 4\.0k tokens · tool declarations 13\.0k · next request 15\.9k · saved this session 1\.1k · tokenizer o200k/);
	assert.match(text, /\| skills \| 2352 \| 59% \|/);
	assert.match(text, /\| Skills advertised \| 2 \| 218 \|/);
});

test("skills, plugins, tools, mcp and context rows carry their state", () => {
	const text = renderReport(data);
	assert.match(text, /\| court \| git:github\.com\/x\/court \| user \| 218 \| 1200 \| enabled \|/);
	assert.match(text, /\| hidden \| npm:demo \| user \| — \| — \| locked \(hidden from the model\) \|/);
	assert.match(text, /\| pi-memory \| npm:pi-memory \| user \| 2 \(memory_write, memory_search\) \| 1 \| 1114 tok \| off this session \|/);
	assert.match(text, /\| read \| direct \| yes \| 130 tok \| builtin:read \|/);
	assert.match(text, /\| codemode \| model-only \| no \| 90 tok \| builtin:codemode \|/);
	assert.match(text, /\| docs \| global \| http mcp\.example\.com \| direct \| yes \| 3 \| 900 tok \|/);
	assert.match(text, /\| old \| project \| stdio npx \| default · disabled \| no \| — \| — \|/);
	assert.match(text, /\| `\/repo\/AGENTS\.md` \| 34 \|/);
	assert.match(text, /arguments, headers and environment are not reported/);
});

test("commands are listed without skill commands and grouped counts work", () => {
	const text = renderReport(data);
	assert.match(text, /`\/memory` \| npm:pi-memory/);
	assert.match(text, /`\/plan` \| npm:@bacnh85\/pi-plan/);
	assert.match(text, /`\/review` \| user/);
});

test("environment lists the session, themes, scoped models and session toggles", () => {
	const text = renderReport(data);
	assert.match(text, /Session file \| `\/sessions\/s1\.jsonl`/);
	assert.match(text, /Themes \| dark, system/);
	assert.match(text, /Scoped models \| deepseek\/deepseek-flash/);
	assert.match(text, /This session off \| 1 skills, 1 tools/);
	assert.doesNotMatch(text, /undefined/);
});

test("empty collections render an explicit placeholder instead of an empty table", () => {
	const text = renderReport({
		...data,
		mcp: [],
		commands: [],
		contextFiles: [],
		themes: undefined,
		scopedModels: undefined,
		sessionFile: undefined,
	});
	assert.match(text, /## MCP servers\n\n_None configured or registered\._/);
	assert.match(text, /## Commands\n\n_None\._/);
	assert.doesNotMatch(text, /Session file/);
	assert.doesNotMatch(text, /undefined/);
});

test("pipes in names cannot break the table layout", () => {
	const text = renderReport({
		...data,
		skills: [row({ kind: "skill", name: "a|b", tokens: 10, state: "enabled" })],
	});
	assert.match(text, /\| a\\\|b \|/);
});
