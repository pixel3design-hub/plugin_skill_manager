import assert from "node:assert/strict";
import test from "node:test";
import {
	computeActiveTools,
	filterSkills,
	normalizeState,
	parseStateEntry,
	restoreState,
	STATE_ENTRY_TYPE,
	toggleSkill,
	toggleTools,
} from "../lib/state.ts";

const skills = [
	{ id: "skill:a", name: "a" },
	{ id: "skill:b", name: "b" },
	{ id: "skill:c", name: "c", disableModelInvocation: true },
];

test("filterSkills drops exactly the disabled ids and keeps hidden skills", () => {
	const state = normalizeState({ disabledSkills: ["skill:b", "skill:missing"] });
	assert.deepEqual(
		filterSkills(skills, state).map((skill) => skill.name),
		["a", "c"],
	);
	assert.deepEqual(filterSkills(skills, normalizeState(undefined)), skills);
});

test("toggling a skill round-trips", () => {
	let state = normalizeState(undefined);
	state = toggleSkill(state, "skill:a");
	assert.deepEqual(state.disabledSkills, ["skill:a"]);
	state = toggleSkill(state, "skill:a");
	assert.deepEqual(state.disabledSkills, []);
});

test("toggling a plugin switches all of its tools together", () => {
	let state = normalizeState(undefined);
	const tools = ["web_search", "web_fetch"];
	state = toggleTools(state, tools);
	assert.deepEqual(state.disabledTools, tools);
	// One tool already off: the next toggle turns the whole plugin back on.
	state = normalizeState({ disabledTools: ["web_search"] });
	state = toggleTools(state, tools);
	assert.deepEqual(state.disabledTools, ["web_search", "web_fetch"]);
	state = toggleTools(state, tools);
	assert.deepEqual(state.disabledTools, []);
});

test("computeActiveTools never resurrects a tool that was inactive at startup", () => {
	const baseline = ["read", "bash", "web_search"];
	const state = normalizeState({ disabledTools: ["web_search", "grep"] });
	assert.deepEqual(computeActiveTools(baseline, state), ["read", "bash"]);
	assert.deepEqual(computeActiveTools(baseline, normalizeState(undefined)), baseline);
});

test("restoreState takes the last state entry on the branch", () => {
	const entries = [
		{ type: "message" },
		{ type: "custom", customType: STATE_ENTRY_TYPE, data: { disabledSkills: ["skill:a"], disabledTools: [] } },
		{ type: "custom", customType: "other", data: { disabledSkills: ["skill:b"] } },
		{ type: "custom", customType: STATE_ENTRY_TYPE, data: { disabledSkills: ["skill:b"], disabledTools: ["grep"] } },
	];
	assert.deepEqual(restoreState(entries), { disabledSkills: ["skill:b"], disabledTools: ["grep"] });
	assert.deepEqual(restoreState([]), { disabledSkills: [], disabledTools: [] });
});

test("parseStateEntry rejects junk and dedupes", () => {
	assert.equal(parseStateEntry(undefined), undefined);
	assert.equal(parseStateEntry({ nope: true }), undefined);
	assert.deepEqual(parseStateEntry({ disabledSkills: ["x", "x", 3], disabledTools: null }), {
		disabledSkills: ["x"],
		disabledTools: [],
	});
});
