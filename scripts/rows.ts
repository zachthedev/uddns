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
 * it reads without checking either. A reviewer refuses a declaration file the
 * repository writes, and the lint row refuses `@ts-nocheck`.
 */
export function unreadSourceFinding(tracked: readonly string[], read: ReadonlySet<string>): string | undefined {
  const unread = tracked.filter((path) => TYPESCRIPT_SOURCE.test(fold(path)) && !read.has(comparable(path)));
  if (unread.length === 0) {
    return undefined;
  }
  return `no project reads ${unread.map((path) => quote(path)).join(', ')}, so tsc never reads ${unread.length === 1 ? 'it' : 'them'}. Add each to a project's include`;
}

/**
 * A finding when `printed`, what `tsc --version` printed, names a major
 * version other than the one `spec`, the package.json entry of the compiler
 * the typecheck row runs, pins, or undefined when the two agree.
 *
 * @remarks
 * Two packages ship a `tsc`, and bun install links `node_modules/.bin/tsc` to
 * the one whose name sorts first. A renamed alias or another tie-break would
 * run the other compiler with the row still green.
 */
export function compilerFinding(printed: string, spec: string): string | undefined {
  const pinned = /(\d+)\.\d+\.\d+$/.exec(spec)?.[1];
  if (pinned === undefined) {
    return `package.json pins the compiler as ${quote(spec)}, which names no version, so which tsc should answer is unknown`;
  }
  const reported = /^Version (\d+)\.\d+\.\d+/m.exec(plain(printed))?.[1];
  if (reported !== pinned) {
    return `tsc --version printed ${quote(plain(printed).trim())}, and package.json pins major ${pinned}, so node_modules/.bin/tsc is another package's compiler`;
  }
  return undefined;
}

/* ///// What ESLint reports ///// */

/** One message ESLint's json formatter reports against a file. */
export interface LintMessage {
  readonly ruleId?: string | null;
  readonly severity?: number;
  readonly message?: string;
  readonly line?: number;
  readonly column?: number;
}

/** One file ESLint's json formatter reports on. */
export interface LintResult {
  readonly filePath: string;
  readonly messages: readonly LintMessage[];
  /** The reports a directive turned off, which ESLint lists whatever the directive says. */
  readonly suppressedMessages: readonly LintMessage[];
}

/** Whether `value`, parsed from ESLint's json output, is one file's result. */
function isLintResult(value: unknown): value is LintResult {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { filePath?: unknown }).filePath === 'string' &&
    Array.isArray((value as { messages?: unknown }).messages) &&
    Array.isArray((value as { suppressedMessages?: unknown }).suppressedMessages)
  );
}

/** The gate's rule that refuses a waiver whose reason holds no letter or digit. */
const VISIBLE_REASON = 'gate/visible-reason';

/** The rule that holds a TypeScript waiver comment to a description. */
const BAN_TS_COMMENT = '@typescript-eslint/ban-ts-comment';

/** The prefix of every rule of the plugin that checks ESLint's own directive comments. */
const ESLINT_COMMENTS = '@eslint-community/eslint-comments/';

/** Whether `ruleId` names a rule that reads comments: the visible-reason rule, ban-ts-comment, or an eslint-comments rule. */
function isCommentRule(ruleId: string | null | undefined): boolean {
  return ruleId === VISIBLE_REASON || ruleId === BAN_TS_COMMENT || (ruleId ?? '').startsWith(ESLINT_COMMENTS);
}

/** Where `message` sits in the file `result` names, as a finding opens. */
function position(result: LintResult, message: LintMessage): string {
  return `${quote(result.filePath)}:${String(message.line ?? 0)}:${String(message.column ?? 0)}`;
}

/**
 * Every file result in the json one ESLint pass, `finished`, printed.
 *
 * @remarks
 * The json formatter prints no control sequence, and every child gets
 * NO_COLOR, so the raw stdout is parsed. {@link plain} strips a one-byte CSI
 * together with the backslash JSON writes before a quote, so stripping first
 * would let a file name rewrite the json's structure. A message string is
 * stripped where the row prints it, after the parse.
 *
 * @throws When the pass printed no json, which means ESLint stopped before it
 * linted anything, or json that is not a list of file results
 */
function lintResults(label: string, finished: Finished): LintResult[] {
  let results: unknown;
  try {
    results = JSON.parse(finished.stdout);
  } catch {
    throw new Error(`${label} ${describe(finished)}`);
  }
  if (!Array.isArray(results) || !results.every((result) => isLintResult(result))) {
    throw new Error(`${label} printed json that is not a list of file results: ${describe(finished)}`);
  }
  return results;
}

/**
 * The file results of the lint row's first pass, `finished`: ESLint over the
 * tree with the repository's config, every comment read and no warning
 * allowed.
 *
 * @remarks
 * ESLint applies a directive to the reports at its own position, so a
 * directive naming {@link VISIBLE_REASON} hides the rule's report on that
 * directive, and a block disable naming it hides every report up to its
 * enable. ESLint lists each report a directive turned off under
 * `suppressedMessages`, which no directive empties and no exit code counts,
 * so each such report of that rule is refused here.
 *
 * @throws When ESLint printed no file results, exited other than 0, naming
 * each problem, linted no file, or turned off a report of
 * {@link VISIBLE_REASON}
 */
export function lintedAsWritten(finished: Finished): LintResult[] {
  const results = lintResults('eslint', finished);
  const problems = results.flatMap((result) =>
    result.messages.map(
      (message) =>
        `${position(result, message)}  ${message.severity === 2 ? 'error' : 'warning'}  ${plain(message.message ?? '')}  ${plain(message.ruleId ?? '')}`,
    ),
  );
  const suppressed = results.flatMap((result) =>
    result.suppressedMessages
      .filter((message) => message.ruleId === VISIBLE_REASON)
      .map(
        (message) =>
          `${position(result, message)}  a directive turned off ${VISIBLE_REASON}, which no directive may do. Take the rule out of the directive and give each waiver a reason in words`,
      ),
  );
  if (finished.exitCode !== 0) {
    throw new Error(
      `eslint exited ${String(finished.exitCode)} over ${files(results.length)}:\n${[...problems, ...suppressed, finished.stderr.trim()].filter((line) => line.length > 0).join('\n')}`,
    );
  }
  if (results.length === 0) {
    throw new Error('eslint linted no file, so it checked nothing');
  }
  if (suppressed.length > 0) {
    throw new Error(suppressed.join('\n'));
  }
  return results;
}

/**
 * The lint row's line from its second pass, `finished`: ESLint over the tree
 * with `--no-inline-config`, against `first`, the first pass's file results.
 *
 * @remarks
 * A configuration comment setting a rule to off turns it off for its whole
 * file, so the rule reports nothing there and nothing lands in
 * `suppressedMessages` either. Under `--no-inline-config` ESLint reads no
 * comment as a directive or as configuration, so every rule that reads
 * comments runs over every file, and each of its reports is one a comment hid
 * from the first pass. That pass exits 1 wherever a directive waives another
 * rule, so its exit code decides nothing but a crash.
 *
 * @throws When the pass printed no file results, exited other than 0 or 1,
 * linted other files than the first pass, or reports a rule that reads
 * comments
 */
export function lintedWithoutComments(finished: Finished, first: readonly LintResult[]): string {
  const label = 'eslint --no-inline-config';
  const results = lintResults(label, finished);
  if (finished.exitCode !== 0 && finished.exitCode !== 1) {
    throw new Error(`${label} ${describe(finished)}`);
  }
  const read = (all: readonly LintResult[]): string[] => all.map((result) => result.filePath).sort();
  const [these, those] = [read(results), read(first)];
  if (these.length !== those.length || these.some((path, index) => path !== those[index])) {
    throw new Error(
      `${label} linted ${files(these.length)} and the first pass ${files(those.length)}, not the same ones, so the two passes read different trees`,
    );
  }
  const unwaived = results.flatMap((result) =>
    result.messages
      .filter((message) => isCommentRule(message.ruleId))
      .map(
        (message) =>
          `${position(result, message)}  ${plain(message.ruleId ?? '')} reports this with every directive and configuration comment ignored, and no comment may turn that rule off: ${plain(message.message ?? '')}`,
      ),
  );
  if (unwaived.length > 0) {
    throw new Error(unwaived.join('\n'));
  }
  return files(results.length);
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
 * many it filtered out. A skip or a todo counts against `allowed`, the skips
 * the gate declares for the suite on this platform, and a count on either side
 * of it fails: one more is a skip nobody declared, and one fewer leaves room
 * for an undeclared skip to pass unseen.
 *
 * @param label - The command, for the row's messages
 * @param finished - The bun test run
 * @param allowed - How many of the suite's tests skip on this platform by
 * design, as the gate declares
 * @throws When it ran no test, when the counts above its `Ran` line do not
 * add up to it, when a test failed, when every test it counted was skipped or
 * left to do, when a name pattern filtered any out, or when the skips and the
 * todos differ from `allowed`
 */
export function testCount(label: string, finished: Finished, allowed: number): string {
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
  if (skipped !== allowed) {
    throw new Error(
      `${label} skipped ${String(skipped)} of its ${String(tests)} tests, and the gate declares ${String(allowed)} on this platform, so ${skipped > allowed ? 'a test skipped that no declaration names' : 'the declaration names a skip that no longer happens'}. Change the test, or the declared count in scripts/check.ts`,
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
 * formats, and no tool asks for a reason. The pinned Prettier honors the comment
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
