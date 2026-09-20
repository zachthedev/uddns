#!/usr/bin/env bun
import { join } from 'node:path';
import { REPO_ROOT } from './lib/wrangler-config';

/**
 * Guard the publish cooldown, which is the only thing between this repository
 * and a version published minutes ago.
 *
 * Two files hold it. `.github/renovate.json` decides what Renovate proposes,
 * and `bunfig.toml` decides what bun resolves during weekly lock file
 * maintenance, which Renovate runs in a container with no user-level config
 * and cannot apply its own cooldown to.
 *
 * A rule may opt out only by matching an entry in ALLOWED_EXEMPTIONS exactly,
 * matcher for matcher. Membership is not enough: a rule that also matched `*`
 * would otherwise exempt every package while naming an approved one.
 *
 * Security fixes are exempt by a Renovate default rather than by this config:
 * `vulnerabilityAlerts` carries `minimumReleaseAge: null`, which no file here
 * states and this check cannot see.
 *
 * Runs from `bun run check` and from its own CI step, so a pull request that
 * weakens the cooldown fails before it merges.
 */

interface PackageRule {
	[key: string]: unknown;
	enabled?: boolean;
	internalChecksFilter?: string;
	minimumReleaseAge?: string | null;
	minimumReleaseAgeBehaviour?: string;
	packageRules?: PackageRule[];
}

interface RenovateConfig {
	extends?: unknown;
	internalChecksFilter?: string;
	minimumReleaseAge?: string;
	minimumReleaseAgeBehaviour?: string;
	packageRules?: PackageRule[];
}

const COOLDOWN = '3 days';
const BUN_COOLDOWN_SECONDS = 259_200;

/**
 * The complete matcher set of every rule allowed to opt out. A rule qualifies
 * only when its matchers equal one of these exactly.
 */
const ALLOWED_EXEMPTIONS: readonly Record<string, readonly string[]>[] = [
	// typescript-eslint peers typescript <6.1.0 and throws on a TypeScript 7
	// tree. The @typescript/native alias carries 7 and is not held.
	{ matchDepNames: ['typescript'], matchUpdateTypes: ['major'] },
	// The action composes its image from renovate-version, a tag and digest in
	// one string no versioning can read. The custom manager owns that pin, and
	// it is gated like everything else.
	{ matchManagers: ['github-actions'], matchDepTypes: ['uses-with'], matchDepNames: ['ghcr.io/renovatebot/renovate'] },
];

const failures: string[] = [];

/** Every `match*` key of a rule, with its values sorted, so order cannot hide a difference. */
function matchersOf(rule: PackageRule): Record<string, string[]> {
	const matchers: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(rule)) {
		if (!key.startsWith('match')) {
			continue;
		}
		matchers[key] = (Array.isArray(value) ? (value as unknown[]).map(String) : [String(value)]).toSorted();
	}
	return matchers;
}

function isAllowed(matchers: Record<string, string[]>): boolean {
	return ALLOWED_EXEMPTIONS.some((allowed) => {
		const keys = Object.keys(allowed).toSorted();
		if (keys.join() !== Object.keys(matchers).toSorted().join()) {
			return false;
		}
		return keys.every((key) => (allowed[key] ?? []).toSorted().join() === (matchers[key] ?? []).join());
	});
}

/** Reports every rule that weakens the cooldown, at any nesting depth. */
function inspect(rules: PackageRule[], path: string): void {
	for (const [index, rule] of rules.entries()) {
		const where = `${path}[${String(index)}]`;
		const weakens: string[] = [];
		// A key set to null reads the same as an absent one, so ask for the key too.
		if ('minimumReleaseAge' in rule && rule.minimumReleaseAge !== COOLDOWN) {
			weakens.push(`minimumReleaseAge ${JSON.stringify(rule.minimumReleaseAge)}`);
		}
		if ('minimumReleaseAgeBehaviour' in rule && rule.minimumReleaseAgeBehaviour !== 'timestamp-required') {
			weakens.push(`minimumReleaseAgeBehaviour ${JSON.stringify(rule.minimumReleaseAgeBehaviour)}`);
		}
		if ('internalChecksFilter' in rule && rule.internalChecksFilter !== 'strict') {
			weakens.push(`internalChecksFilter ${JSON.stringify(rule.internalChecksFilter)}`);
		}
		if (rule.enabled === false) {
			weakens.push('enabled false');
		}
		const matchers = matchersOf(rule);
		if (weakens.length > 0 && !isAllowed(matchers)) {
			failures.push(`${where} sets ${weakens.join(' and ')} and matches ${JSON.stringify(matchers)}`);
		}
		if (Array.isArray(rule.packageRules)) {
			inspect(rule.packageRules, `${where}.packageRules`);
		}
	}
}

let config: RenovateConfig;
const renovatePath = join(REPO_ROOT, '.github', 'renovate.json');
try {
	config = (await Bun.file(renovatePath).json()) as RenovateConfig;
} catch (error) {
	console.error(`.github/renovate.json does not parse: ${String(error)}`);
	process.exit(1);
}

if (config.minimumReleaseAge !== COOLDOWN) {
	failures.push(`minimumReleaseAge is ${JSON.stringify(config.minimumReleaseAge)}, expected "${COOLDOWN}"`);
}
if (config.minimumReleaseAgeBehaviour !== 'timestamp-required') {
	failures.push(`minimumReleaseAgeBehaviour is ${JSON.stringify(config.minimumReleaseAgeBehaviour)}, expected "timestamp-required"`);
}
if (config.internalChecksFilter !== 'strict') {
	failures.push(`internalChecksFilter is ${JSON.stringify(config.internalChecksFilter)}, expected "strict"`);
}
// A preset carries package rules this check never sees, so none is allowed.
if (config.extends !== undefined) {
	failures.push('extends is set, and a preset can carry rules this check cannot resolve');
}
if (config.packageRules !== undefined && !Array.isArray(config.packageRules)) {
	failures.push('packageRules is not an array');
} else {
	inspect(config.packageRules ?? [], 'packageRules');
}

// Parsed rather than matched as text: bun reads minimumReleaseAge under
// [install] alone, and accepts it anywhere else in silence.
const bunfigPath = join(REPO_ROOT, 'bunfig.toml');
try {
	const bunfig = Bun.TOML.parse(await Bun.file(bunfigPath).text()) as { install?: { minimumReleaseAge?: unknown } };
	const configured = bunfig.install?.minimumReleaseAge;
	if (configured !== BUN_COOLDOWN_SECONDS) {
		failures.push(`bunfig.toml [install] minimumReleaseAge is ${JSON.stringify(configured)}, expected ${String(BUN_COOLDOWN_SECONDS)}`);
	}
} catch (error) {
	failures.push(`bunfig.toml does not parse: ${String(error)}`);
}

if (failures.length > 0) {
	console.error('The publish cooldown is not what this repository requires:');
	for (const failure of failures) {
		console.error(`  ${failure}`);
	}
	console.error('An exemption needs its full matcher set in ALLOWED_EXEMPTIONS in scripts/check-cooldown.ts.');
	process.exit(1);
}

console.log(`Cooldown holds: ${COOLDOWN} in renovate.json, ${String(BUN_COOLDOWN_SECONDS)}s in bunfig.toml.`);
