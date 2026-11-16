import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Row } from "../lib/model.ts";
import {
	buildSignals,
	rankRows,
	scanProject,
	scoreRow,
	summarizeSignals,
	tokenize,
} from "../lib/recommend.ts";

function row(input: Partial<Row> & { name: string }): Row {
	const { name, ...rest } = input;
	return {
		kind: "skill",
		id: `skill:${name}`,
		description: "",
		source: "test",
		scope: "user",
		tokens: 100,
		state: "disabled",
		...rest,
		name,
	};
}

test("tokenize drops stopwords, short fragments and numbers", () => {
	assert.deepEqual(tokenize("The TypeScript-refactoring skill for Node.js 2024"), ["typescript", "refactoring", "node"]);
	assert.deepEqual(tokenize("api+v2"), ["api+v2"]);
});

test("signals rank a matching project above an unrelated one", () => {
	const nodeProject = {
		manifests: [
			{
				path: "package.json",
				content: JSON.stringify({ name: "shop", dependencies: { react: "^19", typescript: "^5" }, devDependencies: { vitest: "^4" } }),
			},
		],
		files: ["src/App.tsx", "src/api.ts", "src/App.test.tsx", "README.md"],
		dirs: ["src", "public"],
		readme: "A React storefront with TypeScript.",
		gitPaths: ["src/App.tsx"],
	};
	const pythonProject = {
		manifests: [{ path: "pyproject.toml", content: "[project]\nname = 'ml'\n" }, { path: "requirements.txt", content: "torch==2.3\npandas\n" }],
		files: ["train.py", "model.py", "data.csv"],
		dirs: ["notebooks"],
		readme: "Machine learning experiments in Python.",
		gitPaths: [],
	};

	const rows = [
		row({ name: "react-testing", description: "Testing React components with vitest" }),
		row({ name: "python-ml", description: "Training machine learning models with torch and pandas" }),
	];

	const nodeRanked = rankRows(rows, buildSignals(nodeProject, []));
	assert.equal(nodeRanked[0]!.name, "react-testing");
	assert.deepEqual(nodeRanked.map((entry) => entry.name), ["react-testing"]);

	const pythonRanked = rankRows(rows, buildSignals(pythonProject, []));
	assert.equal(pythonRanked[0]!.name, "python-ml");
});

test("explicit prompt terms dominate the ranking", () => {
	const signals = buildSignals(
		{
			manifests: [],
			files: ["main.go"],
			dirs: [],
			readme: "",
			gitPaths: [],
		},
		["deploy kubernetes charts"],
	);
	const ranked = rankRows(
		[row({ name: "helm-helper", description: "Kubernetes chart deployment" }), row({ name: "go-tools", description: "Go utilities" })],
		signals,
	);
	assert.equal(ranked[0]!.name, "helm-helper");
	assert.ok(ranked[0]!.reasons.includes("kubernetes"));
});

test("rankRows skips forced rows and zero-score rows", () => {
	const signals = buildSignals({ manifests: [], files: [], dirs: [], readme: "", gitPaths: [] });
	const ranked = rankRows(
		[row({ name: "unrelated", state: "forced" }), row({ name: "another" })],
		signals,
	);
	assert.deepEqual(ranked, []);
});

test("scoreRow explains itself with the strongest matching terms", () => {
	const signals = buildSignals({ manifests: [], files: [], dirs: [], readme: "", gitPaths: [] }, ["typescript testing refactor"]);
	const scored = scoreRow(row({ name: "ts-refactor", description: "TypeScript refactoring helper" }), signals);
	assert.ok(scored.score > 0);
	assert.ok(scored.reasons.includes("typescript"));
	assert.ok(scored.reasons.length <= 3);
});

test("scanProject reads manifests, skips node_modules and reports a summary", async () => {
	const dir = mkdtempSync(join(tmpdir(), "skill-manager-"));
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "demo", dependencies: { express: "^4" } }));
	writeFileSync(join(dir, "README.md"), "# Demo\nA tiny express service.");
	mkdirSync(join(dir, "src"));
	writeFileSync(join(dir, "src", "index.ts"), "export {};");
	mkdirSync(join(dir, "node_modules", "junk"), { recursive: true });
	writeFileSync(join(dir, "node_modules", "junk", "index.js"), "module.exports = 1;");

	const snapshot = await scanProject(dir, ["src/index.ts"]);
	assert.deepEqual(snapshot.manifests.map((manifest) => manifest.path), ["package.json"]);
	assert.ok(snapshot.files.includes("src/index.ts"));
	assert.ok(!snapshot.files.some((file) => file.startsWith("node_modules")));
	assert.deepEqual(snapshot.dirs, ["src"]);
	assert.match(snapshot.readme, /express service/);

	const signals = buildSignals(snapshot, []);
	assert.ok(signals.weights.get("express")! >= 4);
	assert.match(summarizeSignals(signals), /deps/);
});
