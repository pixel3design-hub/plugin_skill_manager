import assert from "node:assert/strict";
import test from "node:test";
import {
	auditPrompt,
	countTokens,
	estimateFromChars,
	parseProjectFiles,
	parsePrompt,
	skillAdvertisedTokens,
	skillBlock,
	tokenizerName,
	toolDeclarationTokens,
} from "../lib/tokens.ts";

const PROMPT = `You are a coding assistant running inside pi.

<tools>
- read: Read files
- bash: Run shell commands
</tools>

<rules>
- Use read to examine files
</rules>

<project_context>
Project-specific instructions and guidelines:

<project_instructions path="/repo/AGENTS.md">
Be concise.
</project_instructions>

<project_instructions path="/repo/.pi/AGENTS.md">
Run tests before committing.
</project_instructions>
</project_context>

<skills>

The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.

<available_skills>
  <skill>
    <name>alpha</name>
    <description>Alpha skill</description>
    <location>/skills/alpha/SKILL.md</location>
  </skill>
  <skill>
    <name>beta</name>
    <description>Beta skill</description>
    <location>/skills/beta/SKILL.md</location>
  </skill>
</available_skills>
</skills>

<extra_extension_section>
custom text
</extra_extension_section>

<cwd>
/repo
</cwd>`;

const skill = (name: string) => ({ name, description: `${name} skill`, filePath: `/skills/${name}/SKILL.md` });

function sectionText(prompt: string, name: string): string | undefined {
	return parsePrompt(prompt).sections.find((section) => section.name === name)?.text;
}

test("parsePrompt keeps the preamble and every top-level section", () => {
	const parsed = parsePrompt(PROMPT);
	assert.match(parsed.preamble, /coding assistant/);
	assert.deepEqual(
		parsed.sections.map((section) => section.name),
		["tools", "rules", "project_context", "skills", "extra_extension_section", "cwd"],
	);
	assert.equal(parsed.total, countTokens(PROMPT));
	// Nested tags inside a section must not be mistaken for sections.
	assert.ok(!parsed.sections.some((section) => section.name === "project_instructions"));
});

test("parseProjectFiles splits project context entries", () => {
	const files = parseProjectFiles(sectionText(PROMPT, "project_context"));
	assert.deepEqual(
		files.map((file) => file.path),
		["/repo/AGENTS.md", "/repo/.pi/AGENTS.md"],
	);
	assert.match(files[1]!.content, /Run tests/);
	assert.equal(parseProjectFiles(undefined).length, 0);
});

test("skillBlock matches the Agent Skills prompt format exactly", () => {
	assert.equal(
		skillBlock({ name: "a&b", description: "<d>", filePath: "/x" }),
		[
			"  <skill>",
			"    <name>a&amp;b</name>",
			"    <description>&lt;d&gt;</description>",
			"    <location>/x</location>",
			"  </skill>",
		].join("\n"),
	);
	assert.ok(skillAdvertisedTokens(skill("alpha")) > 0);
});

test("tokenizer is real BPE when the dependency is present, chars/4 otherwise", () => {
	const label = tokenizerName();
	if (label === "o200k") {
		assert.equal(countTokens("hello world"), 2);
	} else {
		assert.equal(countTokens("hello world"), estimateFromChars("hello world"));
	}
	assert.equal(estimateFromChars("abcd"), 1);
	assert.equal(estimateFromChars("abcde"), 2);
	assert.equal(countTokens(""), 0);
});

test("tool declarations are counted from name, description and schema", () => {
	const tokens = toolDeclarationTokens({
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } } },
		exposure: "direct",
	});
	const bigger = toolDeclarationTokens({
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" }, limit: { type: "number" } } },
		exposure: "direct",
	});
	assert.ok(tokens > 0);
	assert.ok(bigger > tokens);
});

test("audit attributes the skills section and projects the session toggles", () => {
	const skills = ["alpha", "beta"].map(skill);
	const sectionTokens = parsePrompt(PROMPT).sections.find((section) => section.name === "skills")!.tokens;
	const advertised = skills.map(skillAdvertisedTokens);
	assert.ok(advertised.every((tokens) => tokens > 0));

	const tools = [
		{ name: "read", description: "Read files", parameters: { type: "object" }, exposure: "direct", source: "builtin", active: true, baselineActive: true, disabled: false },
		{ name: "web_search", description: "Search the web", parameters: { type: "object" }, exposure: "direct", source: "npm:web", active: false, baselineActive: true, disabled: true },
		{ name: "other_tool", description: "Went inactive for another reason", parameters: { type: "object" }, exposure: "direct", source: "npm:web", active: false, baselineActive: true, disabled: false },
	];

	const audit = auditPrompt({
		prompt: PROMPT,
		skills: [
			{ ...skills[0]!, id: "skill:alpha", disabled: false, advertised: true },
			{ ...skills[1]!, id: "skill:beta", disabled: true, advertised: true },
		],
		tools,
	});

	assert.equal(audit.promptTokens, countTokens(PROMPT));
	assert.equal(audit.skillsSectionTokens, sectionTokens);
	assert.ok(audit.skillHeaderTokens >= 0);
	assert.equal(audit.skillCosts[0]!.advertised, advertised[0]);
	assert.ok(audit.baselineToolTokens > audit.activeToolTokens);
	// Only tools this extension switched off count: other_tool went inactive on its own.
	assert.equal(audit.savings, advertised[1]! + audit.toolCosts.web_search!);
	assert.ok(audit.toolCosts.other_tool! > 0);
	assert.equal(
		audit.projectedTokens,
		audit.promptTokens - advertised[1]! + audit.activeToolTokens,
	);
});

test("audit ignores skills Pi never advertises", () => {
	const audit = auditPrompt({
		prompt: PROMPT,
		skills: [{ ...skill("hidden"), id: "skill:hidden", disabled: false, advertised: false }],
		tools: [],
	});
	assert.equal(audit.skillCosts[0]!.advertised, 0);
});
