import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * .node-version names the Node.js the deploy job installs through
 * actions/setup-node, and wrangler runs under it with the deploy's secrets in
 * the job. setup-node reads far more than a version from that file. An empty
 * or whitespace file, or `{}`, resolves to no version, so the step passes with
 * a warning and the runner image's own node stays on PATH. A range or an alias
 * such as `24`, `>=24` or `lts/*` resolves at run time to the newest matching
 * release, which no cooldown held back. JSON is read as a package.json, and
 * `volta.extends` makes the action read and log another file. This suite
 * accepts one exact version on one line and refuses the rest, each with its
 * own reason.
 *
 * The `.node.` infix routes this file to the plain node pool, because workerd
 * backs node:fs with a virtual filesystem and cannot read a repository file
 * off disk.
 */

const NODE_VERSION_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.node-version');

/** Three dot-separated numbers and at most a final newline, the shape Renovate's nodenv manager writes. */
const EXACT_VERSION = /^\d+\.\d+\.\d+\n?$/;

/** Why a refused file is refused, one reason per way setup-node misreads it. */
const reasons = {
  empty: "is empty, so setup-node installs nothing and wrangler runs under the runner image's own node",
  json: 'holds JSON, which setup-node reads as a package.json and follows through volta.extends to another file',
  lines: 'holds more than one line',
  inexact:
    'names a range, an alias or a partial version, which setup-node resolves at run time to a release no cooldown held back',
} as const;

/**
 * The reason `.node-version` holding `contents` is refused.
 *
 * @param contents - The file's text, exactly as read
 * @returns The refusal's reason, or undefined for one exact version on one line
 */
function refusalOf(contents: string): string | undefined {
  if (EXACT_VERSION.test(contents)) {
    return undefined;
  }
  if (contents.trim() === '') {
    return reasons.empty;
  }
  if (contents.trimStart().startsWith('{')) {
    return reasons.json;
  }
  if (contents.replace(/\n$/, '').includes('\n')) {
    return reasons.lines;
  }
  return reasons.inexact;
}

const refused = [
  { name: 'an empty file', contents: '', reason: reasons.empty },
  { name: 'whitespace', contents: ' \t\n', reason: reasons.empty },
  { name: 'an empty JSON object', contents: '{}\n', reason: reasons.json },
  { name: 'JSON naming volta.extends', contents: '{"volta":{"extends":"../package.json"}}\n', reason: reasons.json },
  { name: 'two lines', contents: '24.21.0\n24.20.0\n', reason: reasons.lines },
  { name: 'the lts/* alias', contents: 'lts/*\n', reason: reasons.inexact },
  { name: 'the node alias', contents: 'node\n', reason: reasons.inexact },
  { name: 'a range', contents: '>=24\n', reason: reasons.inexact },
  { name: 'a major alone', contents: '24\n', reason: reasons.inexact },
  { name: 'a major and minor', contents: '24.21\n', reason: reasons.inexact },
  { name: 'a v prefix', contents: 'v24.21.0\n', reason: reasons.inexact },
] as const;

describe('.node-version', () => {
  it('holds one exact version on one line', () => {
    const contents = readFileSync(NODE_VERSION_PATH, 'utf8');
    const refusal = refusalOf(contents);
    expect(
      refusal,
      `.node-version ${refusal ?? ''}. It must hold three dot-separated numbers on one line, which Renovate's nodenv manager bumps under the cooldown`,
    ).toBeUndefined();
  });

  it.each(refused)('refuses $name', ({ contents, reason }) => {
    expect(refusalOf(contents)).toBe(reason);
  });
});
