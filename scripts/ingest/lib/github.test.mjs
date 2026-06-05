import assert from "node:assert/strict";
import test from "node:test";
import {
	createCommitHistoryMarkdown,
	createRepositoryMetadataMarkdown,
	createSourceDocument,
	isEvidencePath,
	selectEvidenceTreeEntries,
} from "./github.mjs";

const repository = {
	name: "sample-project",
	full_name: "nexxucc/sample-project",
	html_url: "https://github.com/nexxucc/sample-project",
	description: "A sample project",
	language: "TypeScript",
	default_branch: "main",
	fork: false,
	archived: false,
	disabled: false,
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-02T00:00:00Z",
	pushed_at: "2026-01-03T00:00:00Z",
	topics: ["ai", "rag"],
	owner: {
		login: "nexxucc",
	},
};

test("isEvidencePath accepts documentation and configuration files", () => {
	assert.equal(isEvidencePath("README.md"), true);
	assert.equal(isEvidencePath("docs/architecture.md"), true);
	assert.equal(isEvidencePath("package.json"), true);
	assert.equal(isEvidencePath(".github/workflows/ci.yml"), true);
	assert.equal(isEvidencePath("src/index.ts"), false);
	assert.equal(isEvidencePath("package-lock.json"), false);
});

test("selectEvidenceTreeEntries prefers readme and limits result count", () => {
	const selected = selectEvidenceTreeEntries(
		[
			{ type: "blob", path: "src/index.ts", size: 120 },
			{ type: "blob", path: "package-lock.json", size: 120 },
			{ type: "blob", path: "README.md", size: 120 },
			{ type: "blob", path: "package.json", size: 120 },
			{ type: "blob", path: "docs/design.md", size: 120 },
		],
		{ maxFiles: 2 },
	);

	assert.deepEqual(
		selected.map((entry) => entry.path),
		["README.md", "docs/design.md"],
	);
});

test("createRepositoryMetadataMarkdown marks repository ownership state", () => {
	const markdown = createRepositoryMetadataMarkdown({
		...repository,
		fork: true,
		archived: true,
	});

	assert.match(markdown, /Fork: Yes/);
	assert.match(markdown, /Archived: Yes/);
	assert.match(markdown, /Topics: ai, rag/);
});

test("createCommitHistoryMarkdown includes public commit metadata", () => {
	const markdown = createCommitHistoryMarkdown(repository, [
		{
			sha: "abcdef1234567890",
			html_url: "https://github.com/nexxucc/sample-project/commit/abcdef",
			commit: {
				message: "Add retrieval pipeline\n\nDetails",
				author: {
					name: "Vansh Jain",
					date: "2026-01-04T00:00:00Z",
				},
			},
		},
	]);

	assert.match(markdown, /abcdef123456/);
	assert.match(markdown, /Add retrieval pipeline/);
	assert.match(markdown, /Vansh Jain/);
});

test("createSourceDocument produces stable document identity", () => {
	const first = createSourceDocument({
		sourceType: "github_readme",
		sourceKey: "github:nexxucc/sample-project:README.md",
		publicUrl: "https://github.com/nexxucc/sample-project/blob/main/README.md",
		title: "nexxucc/sample-project README",
		content: "# Sample\n\nA public README.",
		repository,
		filePath: "README.md",
	});

	const second = createSourceDocument({
		sourceType: "github_readme",
		sourceKey: "github:nexxucc/sample-project:README.md",
		publicUrl: "https://github.com/nexxucc/sample-project/blob/main/README.md",
		title: "nexxucc/sample-project README",
		content: "# Sample\n\nA public README.",
		repository,
		filePath: "README.md",
	});

	assert.equal(first.id, second.id);
	assert.equal(first.repository_owner, "nexxucc");
	assert.equal(first.repository_name, "sample-project");
});
