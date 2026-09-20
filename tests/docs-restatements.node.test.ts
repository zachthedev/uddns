import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * README.md restates facts that are defined elsewhere: the changelog sections
 * release-please publishes, the ones it keeps back, the secrets deploy.yml
 * declares, and the major version the project is on. Each one is read here from
 * the file that owns it, so a name added on one side and not the other fails a
 * check rather than sitting wrong in the documentation.
 *
 * The real files are read rather than fixtures. A fixture would be a third copy
 * of each list, and a third copy drifts the way the second one does.
 *
 * Membership is the contract; order is not. The prose groups the types for a
 * reader and the config groups them for release-please, so the two orders are
 * free to differ.
 *
 * The `.node.` infix routes this file to the plain node pool, because workerd
 * backs node:fs with a virtual filesystem and cannot read these files off disk.
 */

/**
 * This test's own directory, as a path rather than a URL, because the Workers
 * global `URL` the test tsconfig pulls in is not the one `node:fs` accepts.
 */
const here = dirname(fileURLToPath(import.meta.url));

/**
 * A repository file, resolved against this test's own location.
 *
 * Line endings are normalized because the indentation and blank-line anchors
 * below are matched literally, and a CRLF checkout would miss every one.
 */
const read = (relative: string): string => readFileSync(join(here, relative), 'utf8').replace(/\r\n/g, '\n');

const readme = read('../README.md');
const deployWorkflow = read('../.github/workflows/deploy.yml');

/** README prose wraps mid-sentence, so sentence anchors match against one flowed line. */
const prose = readme.replace(/\s+/g, ' ');

/**
 * The single capture group of `pattern`, or a throw naming what was not found.
 *
 * An anchor that quietly matches nothing would leave every comparison below
 * running on an empty list and passing, so a moved anchor has to be loud.
 */
const capture = (text: string, pattern: RegExp, what: string): string => {
	const found = pattern.exec(text)?.[1];
	if (found === undefined) {
		throw new Error(`Could not find ${what}. The wording moved; move this test's anchor with it.`);
	}
	return found;
};

/** Every group-one match of a global pattern, dropping the undefined a non-participating group yields. */
const allOf = (text: string, pattern: RegExp): string[] =>
	[...text.matchAll(pattern)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));

/** Every backticked token in a fragment of prose. */
const backticked = (fragment: string): string[] => allOf(fragment, /`([^`]+)`/g);

interface ChangelogSection {
	type: string;
	hidden?: boolean;
}

/** The changelog sections release-please is configured with for the root package. */
const changelogSections = ((): ChangelogSection[] => {
	const config = JSON.parse(read('../release-please-config.json')) as {
		packages: Record<string, { 'changelog-sections'?: ChangelogSection[] } | undefined>;
	};
	const sections = config.packages['.']?.['changelog-sections'];
	if (sections === undefined) {
		throw new Error('release-please-config.json declares no changelog-sections for the root package.');
	}
	return sections;
})();

/** The commit types whose sections release-please publishes, or the ones it holds back. */
const sectionTypes = (hidden: boolean): string[] =>
	changelogSections.filter((section) => (section.hidden === true) === hidden).map((section) => section.type);

const publishedTypes = sectionTypes(false);

/** The type the README singles out as the minor bump, which its patch list therefore excludes. */
const minorType = capture(prose, /`([a-z]+):` gives a minor/, 'the type the README calls the minor bump');

/** The major version the README's versioning rationale says the project is on. */
const claimedMajor = capture(prose, /Being at (\d+)\.x/, "the README's statement of the major version it is on");

/** The major release-please last cut, which is the number that rationale describes. */
const releasedMajor = ((): string => {
	const manifest = JSON.parse(read('../.release-please-manifest.json')) as Record<string, string | undefined>;
	const version = manifest['.'];
	if (version === undefined) {
		throw new Error('.release-please-manifest.json carries no version for the root package.');
	}
	return capture(version, /^(\d+)\./, `a major version in the released ${version}`);
})();

/**
 * The secret names deploy.yml accepts, matched by shape rather than parsed: the
 * repository carries no YAML dependency, and workflow_call's secrets block is a
 * flat map of names at one fixed depth.
 */
const declaredSecrets = allOf(
	capture(deployWorkflow, /\n {4}secrets:\n([\s\S]*?)\n {2}\S/, 'the workflow_call secrets block in deploy.yml'),
	/^ {6}([A-Z0-9_]+):$/gm,
);

const bindings = [
	{
		list: 'the changelog types that give a patch release',
		owner: 'release-please-config.json',
		where: "README.md's release cadence paragraph",
		owned: publishedTypes.filter((type) => type !== minorType),
		restated: backticked(capture(prose, /gives a patch: ([^.]+)\./, "the README's patch-release type list")),
	},
	{
		list: 'the commit types kept out of the changelog',
		owner: 'release-please-config.json',
		where: "README.md's release cadence paragraph",
		owned: sectionTypes(true),
		restated: backticked(capture(prose, /types kept out of the changelog \(([^)]+)\)/, "the README's out-of-changelog type list")),
	},
	{
		list: 'the repository secrets the deploy takes',
		owner: '.github/workflows/deploy.yml',
		where: "README.md's GitHub Actions setup list",
		owned: declaredSecrets,
		restated: allOf(
			capture(readme, /these repository secrets:\n\n([\s\S]*?)\n\n/, 'the repository-secrets list in README.md'),
			/^- `([A-Z0-9_]+)`/gm,
		),
	},
];

describe('README restatements', () => {
	// The patch list is derived by removing the minor type from the published
	// sections, which only says what the README means while the README's minor
	// type is a published section.
	it('calls a minor bump on a type release-please publishes', () => {
		expect(
			publishedTypes,
			`README.md calls \`${minorType}\` the minor bump, so release-please-config.json must publish its section`,
		).toContain(minorType);
	});

	// The rationale for starting at 1.0.0 stops describing this repository once
	// it leaves that major, so the prose names the major and this reads it back.
	it('names the major version release-please is on', () => {
		expect(
			releasedMajor,
			`README.md says the project is at ${claimedMajor}.x, and .release-please-manifest.json carries a different major`,
		).toBe(claimedMajor);
	});

	describe.each(bindings)('$list', ({ owner, where, owned, restated }) => {
		it(`covers every name ${owner} declares`, () => {
			const missing = owned.filter((name) => !restated.includes(name));
			expect(missing, `${where} omits ${missing.join(', ')}, which ${owner} declares`).toEqual([]);
		});

		it(`names nothing ${owner} does not declare`, () => {
			const surplus = restated.filter((name) => !owned.includes(name));
			expect(surplus, `${where} names ${surplus.join(', ')}, which ${owner} does not declare`).toEqual([]);
		});
	});
});
