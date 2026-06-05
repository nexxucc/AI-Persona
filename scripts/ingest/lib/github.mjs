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
export const DEFAULT_MAX_EVIDENCE_FILES_PER_REPOSITORY = 8;
export const DEFAULT_MAX_EVIDENCE_FILE_BYTES = 120_000;

const evidenceFileBasenames = new Set([
	"dockerfile",
	"docker-compose.yml",
	"docker-compose.yaml",
	"package.json",
	"requirements.txt",
	"pyproject.toml",
	"vite.config.ts",
	"vite.config.js",
	"wrangler.json",
	"wrangler.jsonc",
	"tsconfig.json",
	"tailwind.config.js",
	"tailwind.config.ts",
	"firebase.json",
	"app.json",
	"eas.json",
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

const excludedPathFragments = [
	"/node_modules/",
	"/dist/",
	"/build/",
	"/.git/",
	"/coverage/",
];

const excludedBasenames = new Set([
	"package-lock.json",
	"pnpm-lock.yaml",
	"yarn.lock",
	"bun.lockb",
]);

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

	if (!response.ok) {
		throw new Error(
			`GitHub request failed: ${response.status} ${response.statusText} for ${url}`,
		);
	}

	return response.json();
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

	return evidenceFileExtensions.has(extname(lowerPath)) && lowerPath.split("/").length <= 2;
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
			const leftPath = left.path.toLowerCase();
			const rightPath = right.path.toLowerCase();

			const leftReadme = basename(leftPath).startsWith("readme.");
			const rightReadme = basename(rightPath).startsWith("readme.");

			if (leftReadme !== rightReadme) {
				return leftReadme ? -1 : 1;
			}

			return leftPath.localeCompare(rightPath);
		})
		.slice(0, maxFiles);
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

export function createRepositoryMetadataMarkdown(repository) {
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

	return `${lines.join("\n")}\n`;
}

export function createCommitHistoryMarkdown(repository, commits) {
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

	return `${lines.join("\n")}\n`;
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
