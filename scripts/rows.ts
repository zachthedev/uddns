/**
 * What the gate's rows conclude from what their tools printed, kept apart
 * from the processes that print it, so the suite beside this file covers the
 * logic every repository's check.ts runs.
 *
 * @remarks
 * The same in every repository of the set. It reads Bun and `node:` built-ins
 * and run.ts alone, so check.ts can import it before the preflight.
 */

import { resolve } from 'node:path';
import { describe, type Finished, fold, plain, quote } from './run';

/* ///// Paths and counts ///// */

/** `path` as an absolute path compared without regard to case where the filesystem ignores it. */
export function comparable(path: string): string {
  const absolute = resolve(path);
  return process.platform === 'win32' || process.platform === 'darwin' ? absolute.toLowerCase() : absolute;
}

/** How a count of files reads in a row's line. */
export function files(count: number): string {
  return `${String(count)} ${count === 1 ? 'file' : 'files'}`;
}

/* ///// Typecheck coverage ///// */

/** A TypeScript source file tsc reads, by the end of its name through {@link fold}. */
const TYPESCRIPT_SOURCE = /\.[cm]?tsx?$/;

/**
 * A finding naming every tracked TypeScript file in `tracked` that no project
 * read, or undefined when every one was read. `read` holds each file tsc
 * listed, through {@link comparable}.
 *
 * @remarks
 * Read is not checked: tsc lists a declaration file and a `@ts-nocheck` file
 * it reads without checking either. The preflight refuses an unlisted
 * declaration file, and the lint row refuses `@ts-nocheck`.
 */
export function unreadSourceFinding(tracked: readonly string[], read: ReadonlySet<string>): string | undefined {
  const unread = tracked.filter((path) => TYPESCRIPT_SOURCE.test(fold(path)) && !read.has(comparable(path)));
  if (unread.length === 0) {
    return undefined;
  }
  return `no project reads ${unread.map((path) => quote(path)).join(', ')}, so tsc never reads ${unread.length === 1 ? 'it' : 'them'}. Add each to a project's include`;
}

/* ///// Test counts ///// */

/** The line bun test ends its summary with. */
const RAN = /^Ran (\d+) tests? across (\d+) files?\./;

/** One count in bun test's summary block, such as ` 3 skip`. */
const SUMMARY_COUNT = /^\s*(\d+) (pass|fail|skip|todo|filtered out)$/;

/**
 * What a finished bun test run counted, for the row's line.
 *
 * @remarks
 * bun test prints its summary on stderr and a test's console output on
 * stdout, so the count reads stderr alone. It takes the last `Ran` line, and
 * the pass, fail, skip, todo and filtered-out counts from the block directly
 * above it, back to the blank line that opens the block. A test that prints a
 * summary-shaped line to stderr prints it before bun test's own block, which
 * comes last, and the block's counts must add up to the tests it ran. bun
 * test exits 0 over a file that holds no test and over one whose every test
 * is skipped, and a name pattern leaves tests out of the count and prints how
 * many it filtered out.
 *
 * @throws When it ran no test, when the counts above its `Ran` line do not
 * add up to it, when a test failed, when every test it counted was skipped or
 * left to do, or when a name pattern filtered any out
 */
export function testCount(label: string, finished: Finished): string {
  const lines = plain(finished.stderr).split('\n');
  const at = lines.findLastIndex((line) => RAN.test(line));
  const ran = RAN.exec(lines[at] ?? '');
  const tests = Number(ran?.[1] ?? 0);
  if (tests === 0) {
    throw new Error(`${label} ran no test, so the row checks nothing: ${describe(finished)}`);
  }
  const counts = new Map<string, number>();
  for (let index = at - 1; index >= 0 && (lines[index] ?? '').trim().length > 0; index -= 1) {
    const count = SUMMARY_COUNT.exec(lines[index] ?? '');
    if (count !== null && !counts.has(count[2] ?? '')) {
      counts.set(count[2] ?? '', Number(count[1]));
    }
  }
  const count = (name: string): number => counts.get(name) ?? 0;
  const skipped = count('skip') + count('todo');
  if (count('pass') + count('fail') + skipped !== tests) {
    throw new Error(
      `${label} printed pass, fail, skip and todo counts that do not add up to the ${String(tests)} tests its last Ran line names, so its summary is not bun test's own: ${describe(finished)}`,
    );
  }
  if (count('fail') > 0) {
    throw new Error(`${label} failed ${String(count('fail'))} of its ${String(tests)} tests: ${describe(finished)}`);
  }
  if (skipped >= tests) {
    throw new Error(`${label} skipped every one of its ${String(tests)} tests, so the row checks nothing`);
  }
  if (count('filtered out') > 0) {
    throw new Error(
      `${label} left ${String(count('filtered out'))} tests out through a name pattern, so its count is not the suite`,
    );
  }
  const skip = skipped > 0 ? `, ${String(skipped)} skipped` : '';
  return `${String(tests)} ${tests === 1 ? 'test' : 'tests'} across ${files(Number(ran?.[2] ?? 0))}${skip}`;
}

/* ///// What the workflows and toml rows' tools report checking ///// */

/**
 * Every path in taplo's `found files ... files=[...]` log line, or undefined
 * when it printed none.
 */
export function taploFound(printed: string): string[] | undefined {
  const line = /found files total=\d+ excluded=\d+ files=\[(.*)\]/.exec(plain(printed));
  if (line === null) {
    return undefined;
  }
  return [...(line[1] ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) => (match[1] ?? '').replace(/\\(.)/g, '$1'));
}

/** Every file actionlint's `-verbose` stderr says it finished linting. */
export function actionlintFinished(stderr: string): Set<string> {
  return new Set(
    [...plain(stderr).matchAll(/^(?:verbose: )*Found total \d+ errors? in \d+ ms for (.+?)$/gm)].map(
      (match) => match[1] ?? '',
    ),
  );
}

/** Every input zizmor's info log says it completed, with forward slashes. */
export function zizmorCompleted(stderr: string): Set<string> {
  return new Set(
    [...plain(stderr).matchAll(/completed (.+?)$/gm)].map((match) => (match[1] ?? '').replaceAll('\\', '/')),
  );
}

/* ///// Prettier ignore comments ///// */

// A comment opener Prettier reads an ignore comment in, then spacing or the
// asterisks of a block comment, then the keyword, in any case. The class in
// the keyword keeps this line from matching itself, since the format row
// reads this file too.
const PRETTIER_IGNORE = /(?:\/\/|\/\*|#|<!--|\{\{!(?:--)?)[\s*]*prettier[-]ignore/gi;

/**
 * A finding for every Prettier ignore comment in `text`, the file at `path`,
 * naming the line that carries its keyword.
 *
 * @remarks
 * Prettier leaves the code after the comment as written, in every language it
 * formats, and no tool asks for a reason. Prettier 3.9.8 honors the comment
 * when a `//`, `/*`, `#`, `<!--`, `{{!` or `{{!--` opener precedes the
 * keyword with nothing but spacing between, a block comment spanning lines
 * included, in every language it formats and every language embedded in one.
 * The match is that shape, so a document can name the keyword in prose. A
 * file .prettierignore names is not checked, and changing that list is a gate
 * change.
 */
export function ignoreCommentFindings(path: string, text: string): string[] {
  return [...text.matchAll(PRETTIER_IGNORE)].map((match) => {
    const line = text.slice(0, match.index + match[0].length).split('\n').length;
    return `${quote(path)} line ${String(line)} carries a Prettier ignore comment, which leaves the code after it unformatted with no reason given. Format the code instead`;
  });
}

/* ///// secrets: inherit ///// */

/** One job zizmor reports passing `secrets: inherit`: its file, the line of its `uses:`, and what it calls. */
export interface InheritedCall {
  readonly path: string;
  readonly line: number;
  readonly callee: string;
}

/**
 * The jobs in zizmor's JSON report, `printed` on its stdout, that pass
 * `secrets: inherit`, read from each finding's primary location.
 *
 * @throws When the report is not JSON in the shape zizmor 1.30 prints
 */
export function inheritedCalls(printed: string): InheritedCall[] {
  let report: unknown;
  try {
    report = JSON.parse(plain(printed));
  } catch {
    throw new Error('zizmor printed no json');
  }
  if (!Array.isArray(report)) {
    throw new Error('zizmor printed json that is not a list of findings');
  }
  const calls: InheritedCall[] = [];
  for (const finding of report as unknown[]) {
    const { ident, locations } = (finding ?? {}) as { ident?: unknown; locations?: unknown };
    if (ident !== 'secrets-inherit') {
      continue;
    }
    const primary = (Array.isArray(locations) ? (locations as unknown[]) : []).find(
      (location) => (location as { symbolic?: { kind?: unknown } } | null)?.symbolic?.kind === 'Primary',
    ) as
      | {
          symbolic?: { key?: { Local?: { verbatim_path?: unknown } } };
          concrete?: { feature?: unknown; location?: { start_point?: { row?: unknown } } };
        }
      | undefined;
    const path = primary?.symbolic?.key?.Local?.verbatim_path;
    const row = primary?.concrete?.location?.start_point?.row;
    const feature = primary?.concrete?.feature;
    if (typeof path !== 'string' || typeof row !== 'number' || typeof feature !== 'string') {
      throw new Error('zizmor reported a secrets-inherit finding with no primary file, line and callee');
    }
    calls.push({ path: path.replaceAll('\\', '/'), line: row + 1, callee: feature.replace(/^["']|["']$/g, '') });
  }
  return calls;
}

/**
 * A finding for every call in `calls` whose callee starts with none of
 * `held`, compared without regard to case, and for every file `waived` names
 * that holds no call.
 *
 * @remarks
 * A waiver names a file, not the workflow a job there calls, so a job pointed
 * at another repository keeps its waiver and hands that repository every
 * secret. A waived file with no call means the audit or the waiver went stale,
 * and a hold that counts nothing proves nothing.
 */
export function inheritedCallFindings(
  calls: readonly InheritedCall[],
  held: readonly string[],
  waived: readonly string[],
): string[] {
  const stray = calls
    .filter((call) => !held.some((prefix) => call.callee.toLowerCase().startsWith(prefix)))
    .map(
      (call) =>
        `${quote(call.path)} line ${String(call.line)} passes secrets: inherit to ${quote(call.callee)}. Only a reusable workflow of zachthedev/.github takes a caller's secrets`,
    );
  const idle = waived
    .filter((name) => !calls.some((call) => call.path.split('/').at(-1) === name.split(':')[0]))
    .map(
      (name) =>
        `the secrets-inherit waiver names ${quote(name)}, and zizmor reported no job there passing secrets: inherit, so the waiver or the audit is stale`,
    );
  return [...stray, ...idle];
}
