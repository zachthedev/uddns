import { readFileSync } from 'node:fs';
// eslint lints this file without type information, where URL is not a
// declared global, so it comes from the module that exports it.
import { URL } from 'node:url';

// The one place the scope vocabulary is written down. The commit-msg hook and
// the CI commits job both resolve it from here, so adding a scope is a single
// edit. Resolved against this file rather than the process directory, so the
// vocabulary is found however this module is loaded: by commitlint from the
// repository root, or by the test that imports it from tests/.
const vocabularyPath = new URL('./.github/commit-scopes.json', import.meta.url);
const { scopes } = JSON.parse(readFileSync(vocabularyPath, 'utf8'));

// scope-enum accepts every scope when handed an empty list, so a vocabulary
// that failed to load would read as a passing gate.
if (!Array.isArray(scopes) || scopes.length === 0) {
	throw new Error(`${vocabularyPath.href} must hold a non-empty "scopes" array.`);
}

export default {
	// The specification fixes only feat and fix. The eleven types in use are the
	// Angular convention that config-conventional encodes, so the list lives
	// there rather than here, where it would look like this repository's to
	// extend.
	extends: ['@commitlint/config-conventional'],
	rules: {
		'scope-enum': [2, 'always', scopes],
		// A change that belongs to no single area names no scope, so a bare
		// `fix:` is correct. scope-enum passes an absent scope on its own; this
		// records the intent so an inherited config cannot start demanding one.
		'scope-empty': [0, 'never'],
		// 72 keeps a subject readable in `git log --oneline` inside an 80-column
		// terminal, with room for the hash and any ref decoration.
		'header-max-length': [2, 'always', 72],
		// The same width for the body, so a message reads the same in a terminal
		// as it does on GitHub. A line holding a URL is exempt by the rule.
		'body-max-line-length': [2, 'always', 72],
	},
};
