import assert from "node:assert/strict";
import test from "node:test";
import type { Skill, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { CatalogEntry } from "../lib/model.ts";
import { buildInventory, skillRowId, toolCost } from "../lib/inventory.ts";
import { normalizeState } from "../lib/state.ts";

function skill(
	name: string,
	source: string,
	options: { origin?: "package" | "top-level"; scope?: "user" | "project"; hidden?: boolean } = {},
): Skill {
	return {
		name,
		description: `${name} description`,
		filePath: `/fake/${name}/SKILL.md`,
		baseDir: `/fake/${name}`,
		sourceInfo: {
			path: `/fake/${name}/SKILL.md`,
			source,
			scope: options.scope ?? "user",
			origin: options.origin ?? "package",
		},
		disableModelInvocation: options.hidden ?? false,
	};
}

function tool(
	name: string,
	source: string,
	options: { path?: string; exposure?: "direct" | "deferred" } = {},
): ToolInfo {
	return {
		name,
		description: `${name} tool`,
		parameters: { type: "object", properties: {} },
		exposure: options.exposure ?? "direct",
		sourceInfo: {
			path: options.path ?? `/fake/${name}.ts`,
			source,
			scope: "user",
			origin: "package",
		},
	} as ToolInfo;
}

const catalog: CatalogEntry[] = [
	{ id: "npm:pi-web-access", kind: "plugin", name: "pi-web-access", description: "web", keywords: ["web"], install: "pi install npm:pi-web-access" },
	{ id: "npm:installed-thing", kind: "plugin", name: "installed-thing", description: "x", keywords: [], install: "pi install npm:installed-thing" },
];

test("buildInventory classifies skills, plugins and catalog rows", () => {
	const skills = [
		skill("alpha", "npm:alpha"),
		skill("hidden-one", "npm:alpha", { hidden: true }),
		skill("beta", "local", { origin: "top-level" }),
	];
	const tools = [
		tool("read", "builtin", { path: "builtin:read" }),
		tool("alpha_tool", "npm:alpha"),
		tool("idle_tool", "npm:idle"),
		tool("deferred_tool", "npm:deferred", { exposure: "deferred" }),
	];
	const state = normalizeState({ disabledSkills: [skillRowId(skills[0]!)] });

	const inv = buildInventory({
		skills,
		tools,
		baselineTools: ["read", "alpha_tool"],
		settings: { packages: ["npm:alpha", { source: "npm:installed-thing" }], extensions: ["npm:some-ext"] },
		state,
		catalog,
	});

	const byId = new Map(inv.skills.map((row) => [row.id, row]));
	assert.equal(byId.get("skill:alpha")!.state, "disabled");
	assert.equal(byId.get("skill:hidden-one")!.state, "forced");
	assert.equal(byId.get("skill:hidden-one")!.tokens, 0);
	assert.equal(byId.get("skill:beta")!.state, "enabled");

	const plugins = new Map(inv.plugins.map((row) => [row.id, row]));
	assert.equal(plugins.get("npm:alpha")!.state, "enabled");
	assert.deepEqual(plugins.get("npm:alpha")!.toolNames, ["alpha_tool"]);
	assert.equal(plugins.get("npm:idle")!.state, "forced", "no tool active at startup");
	assert.equal(plugins.get("npm:deferred"), undefined, "non-direct tools are not advertised");
	assert.equal(plugins.get("npm:some-ext")!.state, "forced", "settings-only package with nothing loaded");
	assert.equal(plugins.get("builtin:core")!.toggle, undefined, "core tools are not toggleable");

	// Installed catalog entries disappear; the rest are yellow "available".
	assert.deepEqual(inv.catalog.map((row) => row.id), ["npm:pi-web-access"]);
	assert.equal(inv.catalog[0]!.state, "available");
	assert.match(inv.catalog[0]!.install!, /pi install npm:pi-web-access/);
});

test("plugin rows aggregate prompt cost of their tools and skills", () => {
	const skills = [skill("alpha", "npm:alpha")];
	const tools = [tool("alpha_tool", "npm:alpha")];
	const inv = buildInventory({
		skills,
		tools,
		baselineTools: ["alpha_tool"],
		settings: {},
		state: normalizeState(undefined),
		catalog: [],
	});
	const plugin = inv.plugins.find((row) => row.id === "npm:alpha")!;
	assert.equal(plugin.tokens, inv.skills[0]!.tokens + toolCost(tools[0]!));
	assert.equal(plugin.state, "enabled");
});

test("turning every tool off marks the plugin disabled", () => {
	const tools = [tool("alpha_tool", "npm:alpha")];
	const inv = buildInventory({
		skills: [],
		tools,
		baselineTools: ["alpha_tool"],
		settings: {},
		state: normalizeState({ disabledTools: ["alpha_tool"] }),
		catalog: [],
	});
	const plugin = inv.plugins.find((row) => row.id === "npm:alpha")!;
	assert.equal(plugin.state, "disabled");
	assert.equal(plugin.reason, "1 tools off");
});

test("skill-only packages stay enabled even without tools", () => {
	const inv = buildInventory({
		skills: [skill("humanizer", "git:github.com/blader/humanizer")],
		tools: [],
		baselineTools: [],
		settings: { packages: ["git:github.com/blader/humanizer"] },
		state: normalizeState(undefined),
		catalog: [],
	});
	const plugin = inv.plugins.find((row) => row.id === "git:github.com/blader/humanizer")!;
	assert.equal(plugin.state, "enabled");
	assert.equal(plugin.toggle, undefined);
	assert.match(plugin.description, /1 skills/);
});

test("command-only packages are enabled, sdk/cli tools get no plugin row", () => {
	const tools = [tool("read", "builtin", { path: "builtin:read" }), tool("sdk_tool", "sdk"), tool("cli_tool", "cli")];
	const inv = buildInventory({
		skills: [],
		tools,
		commands: [
			{ name: "footer-config", source: "npm:pi-footer" },
			{ name: "plan", source: "npm:@bacnh85/pi-plan" },
			{ name: "prompt-tokens", source: "local" },
		],
		baselineTools: ["read"],
		settings: { packages: ["npm:pi-footer", "npm:@bacnh85/pi-plan"] },
		state: normalizeState(undefined),
		catalog: [],
	});
	const plugins = new Map(inv.plugins.map((row) => [row.id, row]));
	assert.equal(plugins.get("npm:pi-footer")!.state, "enabled");
	assert.match(plugins.get("npm:pi-footer")!.description, /1 commands/);
	assert.equal(plugins.get("npm:@bacnh85/pi-plan")!.state, "enabled");
	assert.equal(plugins.get("sdk"), undefined);
	assert.equal(plugins.get("cli"), undefined);

	const core = plugins.get("builtin:core")!;
	assert.equal(core.state, "enabled");
	assert.equal(core.reason, "1/1 active");
	assert.equal(core.toggle, undefined);
});
