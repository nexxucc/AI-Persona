import assert from "node:assert/strict";
import test from "node:test";
import {
	classifyEvidenceSourceType,
	createCommitHistoryMarkdown,
	createRepositoryEvidenceSummaryMarkdown,
	createRepositoryMetadataMarkdown,
	createSourceDocument,
	getEvidencePathPriority,
	isEvidencePath,
	isLowSignalRepository,
	isSelectedSourcePath,
	selectEvidenceTreeEntries,
} from "./github.mjs";

const repository = {
	name: "AI-Persona",
	full_name: "nexxucc/AI-Persona",
	html_url: "https://github.com/nexxucc/AI-Persona",
	description: "AI persona interview agent",
	language: "TypeScript",
	default_branch: "main",
	fork: false,
	archived: false,
	disabled: false,
	created_at: "2026-06-04T15:59:21Z",
	updated_at: "2026-06-05T07:39:38Z",
	pushed_at: "2026-06-05T07:39:35Z",
	topics: ["rag", "cloudflare"],
	owner: {
		login: "nexxucc",
	},
};

test("isEvidencePath accepts documentation, config, workflow, and selected source files", () => {
	assert.equal(isEvidencePath("README.md"), true);
	assert.equal(isEvidencePath("docs/architecture.md"), true);
	assert.equal(isEvidencePath(".github/workflows/ci.yml"), true);
	assert.equal(isEvidencePath("package.json"), true);
	assert.equal(isEvidencePath("src/worker/index.ts"), true);
	assert.equal(isEvidencePath("app/main.py"), true);
	assert.equal(isEvidencePath("server/index.js"), true);
});

test("isEvidencePath rejects dependency folders, build outputs, and lockfiles", () => {
	assert.equal(isEvidencePath("node_modules/pkg/index.js"), false);
	assert.equal(isEvidencePath("dist/index.js"), false);
	assert.equal(isEvidencePath("coverage/report.json"), false);
	assert.equal(isEvidencePath("package-lock.json"), false);
	assert.equal(isEvidencePath("yarn.lock"), false);
});

test("isSelectedSourcePath recognizes important implementation paths", () => {
	assert.equal(isSelectedSourcePath("src/models/retriever.py"), true);
	assert.equal(isSelectedSourcePath("scripts/ingest.py"), true);
	assert.equal(isSelectedSourcePath("api/index.js"), true);
	assert.equal(isSelectedSourcePath("main.py"), true);
	assert.equal(isSelectedSourcePath("random/file.png"), false);
});

test("selectEvidenceTreeEntries prioritizes README, docs, config, workflows, and source", () => {
	const selected = selectEvidenceTreeEntries(
		[
			{ type: "blob", path: "src/worker/index.ts", size: 5000 },
			{ type: "blob", path: "README.md", size: 2000 },
			{ type: "blob", path: "docs/architecture.md", size: 2000 },
			{ type: "blob", path: "package.json", size: 1000 },
			{ type: "blob", path: ".github/workflows/ci.yml", size: 1000 },
			{ type: "blob", path: "node_modules/pkg/index.js", size: 1000 },
			{ type: "blob", path: "package-lock.json", size: 1000 },
		],
		{ maxFiles: 5 },
	);

	assert.deepEqual(
		selected.map((entry) => entry.path),
		[
			"README.md",
			"docs/architecture.md",
			"package.json",
			".github/workflows/ci.yml",
			"src/worker/index.ts",
		],
	);
});

test("getEvidencePathPriority ranks evidence paths deterministically", () => {
	assert.equal(getEvidencePathPriority("README.md"), 0);
	assert.equal(getEvidencePathPriority("docs/architecture.md"), 1);
	assert.equal(getEvidencePathPriority("package.json"), 2);
	assert.equal(getEvidencePathPriority(".github/workflows/ci.yml"), 3);
	assert.equal(getEvidencePathPriority("src/index.ts"), 4);
});

test("classifyEvidenceSourceType separates implementation/docs from manifests", () => {
	assert.equal(classifyEvidenceSourceType("docs/architecture.md"), "github_document");
	assert.equal(classifyEvidenceSourceType("src/index.ts"), "github_document");
	assert.equal(classifyEvidenceSourceType("scripts/ingest.py"), "github_document");
	assert.equal(classifyEvidenceSourceType("package.json"), "github_manifest");
	assert.equal(classifyEvidenceSourceType("docker-compose.yml"), "github_manifest");
});

test("createRepositoryMetadataMarkdown includes contributors and low-signal marker", () => {
	const markdown = createRepositoryMetadataMarkdown(
		{
			...repository,
			name: "hacktoberfest",
			full_name: "nexxucc/hacktoberfest",
		},
		[
			{
				login: "nexxucc",
				contributions: 20,
				html_url: "https://github.com/nexxucc",
			},
		],
	);

	assert.match(markdown, /## Contributors/);
	assert.match(markdown, /nexxucc \| contributions: 20/);
	assert.match(markdown, /Low signal repository: Yes/);
});

test("createRepositoryEvidenceSummaryMarkdown includes selected files, commits, file changes, and contributors", () => {
	const markdown = createRepositoryEvidenceSummaryMarkdown({
		repository,
		readme: {
			path: "README.md",
		},
		selectedEntries: [
			{ path: "README.md", size: 1200 },
			{ path: "src/worker/index.ts", size: 2200 },
		],
		commits: [
			{
				sha: "abcdef1234567890",
				html_url: "https://github.com/nexxucc/AI-Persona/commit/abcdef",
				commit: {
					message: "feat: add retrieval",
					author: {
						date: "2026-06-05T00:00:00Z",
					},
				},
			},
		],
		commitDetails: [
			{
				sha: "abcdef1234567890",
				commit: {
					message: "feat: add retrieval",
				},
				files: [
					{ filename: "src/worker/retrieval/hybridRetrieval.ts" },
					{ filename: "src/worker/index.ts" },
				],
			},
		],
		contributors: [
			{
				login: "nexxucc",
				contributions: 10,
				html_url: "https://github.com/nexxucc",
			},
		],
	});

	assert.match(markdown, /## Repository Identity/);
	assert.match(markdown, /README indexed: README.md/);
	assert.match(markdown, /src\/worker\/index.ts/);
	assert.match(markdown, /## Recent Commit Signals/);
	assert.match(markdown, /feat: add retrieval/);
	assert.match(markdown, /## Recent Commit File Changes/);
	assert.match(markdown, /hybridRetrieval.ts/);
	assert.match(markdown, /## Contributor Signals/);
});

test("createCommitHistoryMarkdown includes commit file changes when provided", () => {
	const markdown = createCommitHistoryMarkdown(
		repository,
		[
			{
				sha: "abcdef1234567890",
				html_url: "https://github.com/nexxucc/AI-Persona/commit/abcdef",
				commit: {
					message: "feat: add grounded chat",
					author: {
						date: "2026-06-05T00:00:00Z",
						name: "Vansh Jain",
					},
				},
			},
		],
		[
			{
				sha: "abcdef1234567890",
				files: [
					{ filename: "src/worker/chat/groundedAnswer.ts" },
				],
			},
		],
	);

	assert.match(markdown, /Recent Public Commits/);
	assert.match(markdown, /feat: add grounded chat/);
	assert.match(markdown, /Commit File Changes/);
	assert.match(markdown, /groundedAnswer.ts/);
});

test("isLowSignalRepository marks profile and hacktoberfest repositories", () => {
	assert.equal(isLowSignalRepository({ name: "nexxucc" }), true);
	assert.equal(isLowSignalRepository({ name: "hacktoberfest" }), true);
	assert.equal(isLowSignalRepository({ name: "Hacktoberfest2024" }), true);
	assert.equal(isLowSignalRepository({ name: "NLP-Research-Assistant" }), false);
});

test("createSourceDocument produces stable document identity", () => {
	const document = createSourceDocument({
		sourceType: "github_readme",
		sourceKey: "github:nexxucc/AI-Persona:README.md",
		publicUrl: "https://github.com/nexxucc/AI-Persona/blob/main/README.md",
		title: "nexxucc/AI-Persona README.md",
		content: "# AI Persona\n\nGrounded interview agent.",
		repository,
		filePath: "README.md",
		metadata: {
			language: "TypeScript",
		},
	});

	assert.equal(document.source_type, "github_readme");
	assert.equal(document.repository_owner, "nexxucc");
	assert.equal(document.repository_name, "AI-Persona");
	assert.equal(document.file_path, "README.md");
	assert.equal(document.metadata.language, "TypeScript");
	assert.match(document.id, /^document_/);
	assert.match(document.content_hash, /^[a-f0-9]{64}$/);
});
