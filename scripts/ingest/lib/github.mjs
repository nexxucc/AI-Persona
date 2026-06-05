import { Buffer } from "node:buffer";
import { basename, extname } from "node:path";
import {
	DEFAULT_MAX_CHARS,
	chunkMarkdown,
	createStableId,
	normaliseMarkdown,
	sha256,
} from "./content.mjs";

export const DEFAULT_COMMITS_PER_REPOSITORY = 20;
export const DEFAULT_COMMIT_DETAILS_PER_REPOSITORY = 10;
export const DEFAULT_MAX_EVIDENCE_FILES_PER_REPOSITORY = 28;
export const DEFAULT_MAX_EVIDENCE_FILE_BYTES = 90_000;

const evidenceFileBasenames = new Set([
	".env.example",
	"app.json",
	"cargo.toml",
	"docker-compose.yaml",
	"docker-compose.yml",
	"dockerfile",
	"eas.json",
	"eslint.config.js",
	"firebase.json",
	"next.config.js",
	"next.config.ts",
	"package.json",
	"pyproject.toml",
	"requirements.txt",
	"tailwind.config.js",
	"tailwind.config.ts",
	"tsconfig.json",
	"vite.config.js",
	"vite.config.ts",
	"wrangler.json",
	"wrangler.jsonc",
]);

const evidenceFileExtensions = new Set([
	".md",
	".mdx",
	".txt",
	".json",
	".toml",
	".yaml",
	".yml",
]);

const sourceFileExtensions = new Set([
	".c",
	".cpp",
	".css",
	".go",
	".h",
	".hpp",
	".java",
	".js",
	".jsx",
	".mjs",
	".py",
	".rs",
	".sh",
	".sol",
	".sql",
	".ts",
	".tsx",
]);

const selectedSourcePrefixes = [
	"api/",
	"app/",
	"backend/",
	"components/",
	"frontend/",
	"lib/",
	"models/",
	"pages/",
	"scripts/",
	"server/",
	"src/",
	"tests/",
	"worker/",
];

const selectedSourceBasenames = new Set([
	"app.py",
	"index.js",
	"index.ts",
	"main.cpp",
	"main.py",
	"main.ts",
	"server.js",
	"server.ts",
]);

const excludedPathFragments = [
	"/.git/",
	"/.next/",
	"/.venv/",
	"/build/",
	"/coverage/",
	"/dist/",
	"/node_modules/",
	"/target/",
];

const excludedBasenames = new Set([
	"bun.lockb",
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
]);

const lowSignalRepositoryPatterns = [
	/^nexxucc$/i,
	/hacktoberfest/i,
];

export function getGitHubToken() {
	return process.env.GITHUB_SOURCE_TOKEN?.trim() || "";
}

export function buildGitHubHeaders(token = getGitHubToken()) {
	const headers = {
		Accept: "application/vnd.github+json",
		"User-Agent": "ai-persona-source-ingestion",
		"X-GitHub-Api-Version": "2022-11-28",
	};

	if (token) {
		headers.Authorization = `Bearer ${token}`;
	}

	return headers;
}

export async function githubFetchJson(url, token = getGitHubToken()) {
	const response = await fetch(url, {
		headers: buildGitHubHeaders(token),
	});

	if (response.status === 204) {
		return null;
	}

	if (!response.ok) {
		throw new Error(
			`GitHub request failed: ${response.status} ${response.statusText} for ${url}`,
		);
	}

	const body = await response.text();

	if (!body.trim()) {
		return null;
	}

	return JSON.parse(body);
}

export async function fetchAllPublicRepositories(owner, token = getGitHubToken()) {
	const repositories = [];

	for (let page = 1; ; page += 1) {
		const pageResults = await githubFetchJson(
			`https://api.github.com/users/${owner}/repos?type=public&sort=updated&per_page=100&page=${page}`,
			token,
		);

		repositories.push(...pageResults);

		if (pageResults.length < 100) {
			break;
		}
	}

	return repositories;
}

export async function fetchRepositoryReadme(owner, repositoryName, token = getGitHubToken()) {
	const url = `https://api.github.com/repos/${owner}/${repositoryName}/readme`;

	const response = await fetch(url, {
		headers: buildGitHubHeaders(token),
	});

	if (response.status === 404) {
		return null;
	}

	if (!response.ok) {
		throw new Error(
			`GitHub README request failed: ${response.status} ${response.statusText} for ${owner}/${repositoryName}`,
		);
	}

	const readme = await response.json();
	const content = Buffer.from(readme.content ?? "", "base64").toString("utf8");

	return {
		path: readme.path,
		publicUrl: readme.html_url,
		content,
	};
}

export async function fetchRepositoryTree(owner, repositoryName, defaultBranch, token = getGitHubToken()) {
	const tree = await githubFetchJson(
		`https://api.github.com/repos/${owner}/${repositoryName}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
		token,
	);

	return Array.isArray(tree.tree) ? tree.tree : [];
}

export async function fetchRecentCommits(
	owner,
	repositoryName,
	limit = DEFAULT_COMMITS_PER_REPOSITORY,
	token = getGitHubToken(),
) {
	return githubFetchJson(
		`https://api.github.com/repos/${owner}/${repositoryName}/commits?per_page=${limit}`,
		token,
	);
}

export async function fetchCommitDetails(owner, repositoryName, sha, token = getGitHubToken()) {
	return githubFetchJson(
		`https://api.github.com/repos/${owner}/${repositoryName}/commits/${sha}`,
		token,
	);
}

export async function fetchRepositoryContributors(
	owner,
	repositoryName,
	limit = 20,
	token = getGitHubToken(),
) {
	const contributors = await githubFetchJson(
		`https://api.github.com/repos/${owner}/${repositoryName}/contributors?per_page=${limit}`,
		token,
	);

	return Array.isArray(contributors) ? contributors : [];
}

export function isEvidencePath(path) {
	const normalized = `/${path}`;
	const lowerPath = path.toLowerCase();
	const base = basename(lowerPath);

	if (excludedBasenames.has(base)) {
		return false;
	}

	if (excludedPathFragments.some((fragment) => normalized.includes(fragment))) {
		return false;
	}

	if (lowerPath.startsWith(".github/workflows/")) {
		return true;
	}

	if (lowerPath.startsWith("docs/") && evidenceFileExtensions.has(extname(lowerPath))) {
		return true;
	}

	if (base.startsWith("readme.")) {
		return true;
	}

	if (evidenceFileBasenames.has(base)) {
		return true;
	}

	if (isSelectedSourcePath(lowerPath)) {
		return true;
	}

	return evidenceFileExtensions.has(extname(lowerPath)) && lowerPath.split("/").length <= 2;
}

export function isSelectedSourcePath(path) {
	const lowerPath = path.toLowerCase();
	const base = basename(lowerPath);

	if (!sourceFileExtensions.has(extname(lowerPath))) {
		return false;
	}

	if (selectedSourceBasenames.has(base)) {
		return true;
	}

	return selectedSourcePrefixes.some((prefix) => lowerPath.startsWith(prefix));
}

export function selectEvidenceTreeEntries(treeEntries, options = {}) {
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_EVIDENCE_FILES_PER_REPOSITORY;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_EVIDENCE_FILE_BYTES;

	return treeEntries
		.filter((entry) => entry.type === "blob")
		.filter((entry) => typeof entry.path === "string")
		.filter((entry) => isEvidencePath(entry.path))
		.filter((entry) => typeof entry.size !== "number" || entry.size <= maxBytes)
		.sort((left, right) => {
			const priorityDifference =
				getEvidencePathPriority(left.path) - getEvidencePathPriority(right.path);

			if (priorityDifference !== 0) {
				return priorityDifference;
			}

			return left.path.toLowerCase().localeCompare(right.path.toLowerCase());
		})
		.slice(0, maxFiles);
}

export function getEvidencePathPriority(path) {
	const lowerPath = path.toLowerCase();
	const base = basename(lowerPath);

	if (base.startsWith("readme.")) {
		return 0;
	}

	if (lowerPath.startsWith("docs/")) {
		return 1;
	}

	if (evidenceFileBasenames.has(base)) {
		return 2;
	}

	if (lowerPath.startsWith(".github/workflows/")) {
		return 3;
	}

	if (isSelectedSourcePath(lowerPath)) {
		return 4;
	}

	return 5;
}

export function classifyEvidenceSourceType(path) {
	const lowerPath = path.toLowerCase();

	if (
		lowerPath.startsWith("docs/") ||
		lowerPath.startsWith("src/") ||
		lowerPath.startsWith("app/") ||
		lowerPath.startsWith("server/") ||
		lowerPath.startsWith("worker/") ||
		lowerPath.startsWith("lib/") ||
		lowerPath.startsWith("scripts/") ||
		isSelectedSourcePath(lowerPath)
	) {
		return "github_document";
	}

	return "github_manifest";
}

export function buildRawFileUrl(repository, filePath) {
	return `https://raw.githubusercontent.com/${repository.full_name}/${repository.default_branch}/${filePath}`;
}

export async function fetchRawTextFile(repository, filePath) {
	const response = await fetch(buildRawFileUrl(repository, filePath), {
		headers: {
			"User-Agent": "ai-persona-source-ingestion",
		},
	});

	if (!response.ok) {
		throw new Error(
			`Raw file request failed: ${response.status} ${response.statusText} for ${repository.full_name}/${filePath}`,
		);
	}

	return response.text();
}

export function createRepositoryMetadataMarkdown(repository, contributors = []) {
	const lines = [
		`# ${repository.full_name}`,
		"",
		"## Repository Metadata",
		"",
		`- Name: ${repository.name}`,
		`- Full name: ${repository.full_name}`,
		`- Public URL: ${repository.html_url}`,
		`- Description: ${repository.description ?? "No description provided"}`,
		`- Primary language: ${repository.language ?? "Not specified"}`,
		`- Default branch: ${repository.default_branch}`,
		`- Fork: ${repository.fork ? "Yes" : "No"}`,
		`- Archived: ${repository.archived ? "Yes" : "No"}`,
		`- Disabled: ${repository.disabled ? "Yes" : "No"}`,
		`- Created at: ${repository.created_at}`,
		`- Updated at: ${repository.updated_at}`,
		`- Last pushed at: ${repository.pushed_at}`,
	];

	if (Array.isArray(repository.topics) && repository.topics.length > 0) {
		lines.push(`- Topics: ${repository.topics.join(", ")}`);
	}

	if (contributors.length > 0) {
		lines.push("", "## Contributors", "");

		for (const contributor of contributors.slice(0, 10)) {
			lines.push(
				`- ${contributor.login} | contributions: ${contributor.contributions} | ${contributor.html_url}`,
			);
		}
	}

	if (isLowSignalRepository(repository)) {
		lines.push("", "## Evidence Quality", "", "- Low signal repository: Yes");
	}

	return `${lines.join("\n")}\n`;
}

export function createRepositoryEvidenceSummaryMarkdown({
	repository,
	readme,
	selectedEntries,
	commits,
	commitDetails,
	contributors,
}) {
	const lines = [
		`# ${repository.full_name} Evidence Summary`,
		"",
		"## Repository Identity",
		"",
		`- Name: ${repository.name}`,
		`- URL: ${repository.html_url}`,
		`- Description: ${repository.description ?? "No description provided"}`,
		`- Primary language: ${repository.language ?? "Not specified"}`,
		`- Topics: ${Array.isArray(repository.topics) && repository.topics.length > 0 ? repository.topics.join(", ") : "None"}`,
		`- Default branch: ${repository.default_branch}`,
		`- Fork: ${repository.fork ? "Yes" : "No"}`,
		`- Archived: ${repository.archived ? "Yes" : "No"}`,
	];

	if (readme?.path) {
		lines.push(`- README indexed: ${readme.path}`);
	}

	if (isLowSignalRepository(repository)) {
		lines.push(`- Low signal repository: Yes`);
	}

	lines.push("", "## Indexed Evidence Files", "");

	for (const entry of selectedEntries.slice(0, 20)) {
		lines.push(
			`- ${entry.path} | type: ${classifyEvidenceSourceType(entry.path)} | size: ${entry.size ?? "unknown"} bytes`,
		);
	}

	if (contributors.length > 0) {
		lines.push("", "## Contributor Signals", "");

		for (const contributor of contributors.slice(0, 10)) {
			lines.push(
				`- ${contributor.login} | contributions: ${contributor.contributions} | ${contributor.html_url}`,
			);
		}
	}

	if (commits.length > 0) {
		lines.push("", "## Recent Commit Signals", "");

		for (const commit of commits.slice(0, 12)) {
			const sha = commit.sha.slice(0, 12);
			const message = commit.commit?.message?.split("\n")[0] ?? "No commit message";
			const date = commit.commit?.author?.date ?? commit.commit?.committer?.date ?? "Unknown date";

			lines.push(`- ${sha} | ${date} | ${message} | ${commit.html_url}`);
		}
	}

	if (commitDetails.length > 0) {
		lines.push("", "## Recent Commit File Changes", "");

		for (const detail of commitDetails.slice(0, 10)) {
			const sha = detail.sha.slice(0, 12);
			const message = detail.commit?.message?.split("\n")[0] ?? "No commit message";
			const files = Array.isArray(detail.files)
				? detail.files.slice(0, 12).map((file) => file.filename).join(", ")
				: "No files returned";

			lines.push(`- ${sha} | ${message} | files: ${files}`);
		}
	}

	return `${lines.join("\n")}\n`;
}

export function createCommitHistoryMarkdown(repository, commits, commitDetails = []) {
	const lines = [
		`# ${repository.full_name} Commit Metadata`,
		"",
		"## Recent Public Commits",
		"",
	];

	for (const commit of commits) {
		const sha = commit.sha.slice(0, 12);
		const message = commit.commit?.message?.split("\n")[0] ?? "No commit message";
		const date = commit.commit?.author?.date ?? commit.commit?.committer?.date ?? "Unknown date";
		const author = commit.commit?.author?.name ?? "Unknown author";
		const url = commit.html_url;

		lines.push(`- ${sha} | ${date} | ${author} | ${message} | ${url}`);
	}

	if (commitDetails.length > 0) {
		lines.push("", "## Commit File Changes", "");

		for (const detail of commitDetails.slice(0, 10)) {
			const sha = detail.sha.slice(0, 12);
			const files = Array.isArray(detail.files)
				? detail.files.slice(0, 12).map((file) => file.filename).join(", ")
				: "No files returned";

			lines.push(`- ${sha} | files: ${files}`);
		}
	}

	return `${lines.join("\n")}\n`;
}

export function isLowSignalRepository(repository) {
	return lowSignalRepositoryPatterns.some((pattern) => pattern.test(repository.name));
}

export function createSourceDocument({
	sourceType,
	sourceKey,
	publicUrl,
	title,
	content,
	repository,
	filePath,
	commitSha,
	metadata = {},
}) {
	const normalisedContent = normaliseMarkdown(content);

	return {
		id: createStableId("document", sourceKey),
		source_type: sourceType,
		source_key: sourceKey,
		repository_owner: repository?.owner?.login ?? repository?.full_name?.split("/")[0] ?? null,
		repository_name: repository?.name ?? null,
		file_path: filePath ?? null,
		commit_sha: commitSha ?? null,
		public_url: publicUrl,
		title,
		content: normalisedContent,
		content_hash: sha256(normalisedContent),
		metadata,
	};
}

export function createChunksForDocument(document, options = {}) {
	const chunks = chunkMarkdown(document.content, {
		maxChars: options.maxChars ?? DEFAULT_MAX_CHARS,
	});

	return chunks.map((chunk, index) => {
		const seed = `${document.source_key}:${index}:${chunk.content}`;

		return {
			id: createStableId("chunk", seed),
			document_id: document.id,
			chunk_index: index,
			content: chunk.content,
			title: document.title,
			source_type: document.source_type,
			repository_name: document.repository_name,
			file_path: document.file_path,
			commit_sha: document.commit_sha,
			public_url: document.public_url,
			content_hash: sha256(chunk.content),
			vector_id: createStableId("vector", seed),
			metadata: {
				...document.metadata,
				heading_path: chunk.headingPath,
			},
		};
	});
}
