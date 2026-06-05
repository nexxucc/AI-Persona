import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	createChunksForDocument,
	createCommitHistoryMarkdown,
	createRepositoryMetadataMarkdown,
	createSourceDocument,
	fetchAllPublicRepositories,
	fetchRawTextFile,
	fetchRecentCommits,
	fetchRepositoryReadme,
	fetchRepositoryTree,
	getGitHubToken,
	selectEvidenceTreeEntries,
} from "./lib/github.mjs";

const manifestPath = "sources/source-manifest.json";
const outputPath = "local-data/generated/github-corpus-preview.json";

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const owner = manifest.github?.owner;

if (!owner) {
	throw new Error("The source manifest does not define a GitHub owner.");
}

const token = getGitHubToken();
const repositories = await fetchAllPublicRepositories(owner, token);
const documents = [];
const warnings = [];

for (const repository of repositories) {
	documents.push(
		createSourceDocument({
			sourceType: "github_repository",
			sourceKey: `github:${repository.full_name}:metadata`,
			publicUrl: repository.html_url,
			title: `${repository.full_name} Repository Metadata`,
			content: createRepositoryMetadataMarkdown(repository),
			repository,
			metadata: {
				fork: repository.fork,
				archived: repository.archived,
				language: repository.language,
				default_branch: repository.default_branch,
			},
		}),
	);

	try {
		const readme = await fetchRepositoryReadme(owner, repository.name, token);

		if (readme?.content?.trim()) {
			documents.push(
				createSourceDocument({
					sourceType: "github_readme",
					sourceKey: `github:${repository.full_name}:${readme.path}`,
					publicUrl: readme.publicUrl,
					title: `${repository.full_name} ${readme.path}`,
					content: readme.content,
					repository,
					filePath: readme.path,
					metadata: {
						fork: repository.fork,
						archived: repository.archived,
						default_branch: repository.default_branch,
					},
				}),
			);
		}
	} catch (error) {
		warnings.push({
			repository: repository.full_name,
			source: "readme",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	try {
		const treeEntries = await fetchRepositoryTree(
			owner,
			repository.name,
			repository.default_branch,
			token,
		);

		const selectedEntries = selectEvidenceTreeEntries(treeEntries).filter(
			(entry) => !entry.path.toLowerCase().startsWith("readme."),
		);

		for (const entry of selectedEntries) {
			try {
				const content = await fetchRawTextFile(repository, entry.path);

				if (!content.trim()) {
					continue;
				}

				documents.push(
					createSourceDocument({
						sourceType: entry.path.startsWith("docs/")
							? "github_document"
							: "github_manifest",
						sourceKey: `github:${repository.full_name}:${entry.path}`,
						publicUrl: `${repository.html_url}/blob/${repository.default_branch}/${entry.path}`,
						title: `${repository.full_name} ${entry.path}`,
						content,
						repository,
						filePath: entry.path,
						metadata: {
							fork: repository.fork,
							archived: repository.archived,
							default_branch: repository.default_branch,
							size_bytes: entry.size ?? null,
						},
					}),
				);
			} catch (error) {
				warnings.push({
					repository: repository.full_name,
					source: entry.path,
					message: error instanceof Error ? error.message : String(error),
				});
			}
		}
	} catch (error) {
		warnings.push({
			repository: repository.full_name,
			source: "tree",
			message: error instanceof Error ? error.message : String(error),
		});
	}

	try {
		const commits = await fetchRecentCommits(owner, repository.name, undefined, token);

		if (commits.length > 0) {
			documents.push(
				createSourceDocument({
					sourceType: "github_commit",
					sourceKey: `github:${repository.full_name}:recent-commits`,
					publicUrl: `${repository.html_url}/commits/${repository.default_branch}`,
					title: `${repository.full_name} Recent Commit Metadata`,
					content: createCommitHistoryMarkdown(repository, commits),
					repository,
					metadata: {
						fork: repository.fork,
						archived: repository.archived,
						default_branch: repository.default_branch,
						commit_count: commits.length,
					},
				}),
			);
		}
	} catch (error) {
		warnings.push({
			repository: repository.full_name,
			source: "commits",
			message: error instanceof Error ? error.message : String(error),
		});
	}
}

const chunks = documents.flatMap((document) => createChunksForDocument(document));

const preview = {
	manifest_version: manifest.version,
	github_owner: owner,
	repositories: repositories.map((repository) => ({
		name: repository.name,
		full_name: repository.full_name,
		fork: repository.fork,
		archived: repository.archived,
		default_branch: repository.default_branch,
		language: repository.language,
		public_url: repository.html_url,
	})),
	documents,
	chunks,
	warnings,
	report: {
		repository_count: repositories.length,
		fork_count: repositories.filter((repository) => repository.fork).length,
		archived_count: repositories.filter((repository) => repository.archived).length,
		document_count: documents.length,
		chunk_count: chunks.length,
		warning_count: warnings.length,
	},
};

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(preview, null, 2)}\n`, "utf8");

console.log(`GitHub repositories found: ${preview.report.repository_count}`);
console.log(`Fork repositories found: ${preview.report.fork_count}`);
console.log(`Archived repositories found: ${preview.report.archived_count}`);
console.log(`GitHub documents prepared: ${preview.report.document_count}`);
console.log(`GitHub chunks prepared: ${preview.report.chunk_count}`);
console.log(`Warnings: ${preview.report.warning_count}`);
console.log(`Local preview written to: ${outputPath}`);

if (warnings.length > 0) {
	console.log("");
	console.log("Warnings:");
	for (const warning of warnings) {
		console.log(`- ${warning.repository} ${warning.source}: ${warning.message}`);
	}
}
