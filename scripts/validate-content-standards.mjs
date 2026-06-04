import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const allowedExtensions = new Set([
	".css",
	".html",
	".js",
	".json",
	".md",
	".ts",
	".tsx",
]);

const targets = ["README.md", "docs", "public", "sources", "src"];

function isForbiddenSymbol(character) {
	const codepoint = character.codePointAt(0);

	return (
		(codepoint >= 0x1f000 && codepoint <= 0x1faff) ||
		(codepoint >= 0x2600 && codepoint <= 0x27bf) ||
		codepoint === 0xfe0f
	);
}

function collectFiles(target) {
	if (!existsSync(target)) {
		return [];
	}

	if (!statSync(target).isDirectory()) {
		return allowedExtensions.has(extname(target)) ? [target] : [];
	}

	return readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
		const path = join(target, entry.name);

		if (entry.isDirectory()) {
			return collectFiles(path);
		}

		return allowedExtensions.has(extname(path)) ? [path] : [];
	});
}

const failures = [];

for (const path of targets.flatMap(collectFiles)) {
	const contents = readFileSync(path, "utf-8");

	for (const [index, line] of contents.split(/\r?\n/).entries()) {
		const symbols = [...line].filter(isForbiddenSymbol);

		if (symbols.length > 0) {
			failures.push({
				path,
				lineNumber: index + 1,
			});
		}
	}
}

if (failures.length > 0) {
	console.error("Content standards check failed. Forbidden decorative symbols found:");

	for (const failure of failures) {
		console.error(`- ${failure.path}:${failure.lineNumber}`);
	}

	process.exitCode = 1;
} else {
	console.log("Content standards check passed.");
}
