import { expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { ESLint } from 'eslint';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { gatePlugin } from './eslint-plugin';
import {
  actionlintFinished,
  comparable,
  compilerFinding,
  ignoreCommentFindings,
  lintedAsWritten,
  lintedWithoutComments,
  taploFound,
  testCount,
  unreadSourceFinding,
  zizmorCompleted,
} from './rows';
import { type Finished, plain, printable, quote } from './run';

// Loading typescript-eslint takes seconds on a cold cache.
setDefaultTimeout(30_000);

/** An asymmetric matcher for a finding carrying `fragment`. */
function carrying(fragment: string): string {
  return expect.stringContaining(fragment) as string;
}

// Escape characters spelled from their code points, so none is written into
// this file literally.
const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);
const BEL = String.fromCharCode(0x07);

/** `text` wrapped in the color codes a terminal-aware tool prints around a word. */
function colored(text: string): string {
  return `${ESC}[0m${ESC}[1;32m${text}${ESC}[0m`;
}

/* ///// Printing and reading tool output ///// */

test.each([
  ['a color code', `${ESC}[31mred${ESC}[0m`, 'red'],
  ['a 24-bit color code', `${ESC}[38;2;5;5;5mdim${ESC}[m`, 'dim'],
  ['the one-byte CSI', `${CSI}1mbold${CSI}0m`, 'bold'],
  ['a hyperlink ended by BEL', `${ESC}]8;;https://x.test${BEL}link${ESC}]8;;${BEL}`, 'link'],
  ['a hyperlink ended by ESC and a backslash', `${ESC}]8;;https://x.test${ESC}\\link${ESC}]8;;${ESC}\\`, 'link'],
  ['Windows line endings', 'a\r\nb\r\n', 'a\nb\n'],
])('plain removes %s', (_label: string, printed: string, expected: string) => {
  expect(plain(printed)).toBe(expected);
});

test('printable escapes every control character but tab and newline, and every invisible mark', () => {
  const line = `a${BEL}b\tc${ESC}[2Kd\re${String.fromCharCode(0x202e)}f${String.fromCharCode(0x85)}g\r\nh`;

  expect(printable(line)).toBe('a\\u0007b\tc\\u001b[2Kd\\u000de\\u202ef\\u0085g\nh');
});

// A runner reads a line of a job's log that starts with :: as a workflow
// command, and it breaks lines at a carriage return as at a newline.
test.each([
  ['a newline', `docs/a\n::error::x.md`, '"docs/a\\n::error::x.md"'],
  ['a carriage return', `docs/a\r::error::x.md`, '"docs/a\\r::error::x.md"'],
  ['both', `a\r\n::warning::b`, '"a\\r\\n::warning::b"'],
])('quote keeps input holding %s on one line, escaped', (_label: string, input: string, expected: string) => {
  const quoted = quote(input);

  expect(quoted).toBe(expected);
  expect(printable(`finding: ${quoted}`).split('\n')).toHaveLength(1);
});

/* ///// Test counts ///// */

/** A bun test run that exited 0 printing `summary` on stderr, where bun test prints it, and `stdout` on stdout. */
function ended(summary: string, stdout = ''): Finished {
  return { exitCode: 0, stdout, stderr: summary, heldOpen: false };
}

interface CountCase {
  readonly label: string;
  readonly summary: string;
  /** What the run printed on stdout, where a test's console output goes. */
  readonly stdout?: string;
  /** The skips the gate declares for the run, none when absent. */
  readonly allowed?: number;
  /** The row's line, or undefined when the count must throw. */
  readonly line?: string;
  /** A fragment the throw carries. */
  readonly refused?: string;
}

// Each summary is written the way the pinned Bun prints it.
const COUNTS: readonly CountCase[] = [
  {
    label: 'a passing run',
    summary: ' 7 pass\n 0 fail\n 9 expect() calls\nRan 7 tests across 2 files. [80.00ms]\n',
    line: '7 tests across 2 files',
  },
  {
    label: 'one test in one file',
    summary: ' 1 pass\n 0 fail\nRan 1 test across 1 file. [8.00ms]\n',
    line: '1 test across 1 file',
  },
  {
    label: 'as many skipped as the gate declares, as on a platform a case does not run on',
    summary: ' 5 pass\n 2 skip\n 0 fail\nRan 7 tests across 2 files. [80.00ms]\n',
    allowed: 2,
    line: '7 tests across 2 files, 2 skipped',
  },
  {
    label: 'a skip and a todo, together as many as the gate declares',
    summary: ' 5 pass\n 1 skip\n 1 todo\n 0 fail\nRan 7 tests across 2 files. [80.00ms]\n',
    allowed: 2,
    line: '7 tests across 2 files, 2 skipped',
  },
  {
    label: 'one more skipped than the gate declares',
    summary: ' 4 pass\n 3 skip\n 0 fail\nRan 7 tests across 2 files. [80.00ms]\n',
    allowed: 2,
    refused:
      'bun test skipped 3 of its 7 tests, and the gate declares 2 on this platform, so a test skipped that no declaration names',
  },
  {
    label: 'a skip where the gate declares none',
    summary: ' 6 pass\n 1 skip\n 0 fail\nRan 7 tests across 2 files. [80.00ms]\n',
    refused: 'bun test skipped 1 of its 7 tests, and the gate declares 0 on this platform',
  },
  {
    label: 'a todo where the gate declares none',
    summary: ' 6 pass\n 1 todo\n 0 fail\nRan 7 tests across 2 files. [80.00ms]\n',
    refused: 'bun test skipped 1 of its 7 tests, and the gate declares 0 on this platform',
  },
  {
    label: 'one fewer skipped than the gate declares',
    summary: ' 6 pass\n 1 skip\n 0 fail\nRan 7 tests across 2 files. [80.00ms]\n',
    allowed: 2,
    refused:
      'bun test skipped 1 of its 7 tests, and the gate declares 2 on this platform, so the declaration names a skip that no longer happens',
  },
  {
    label: 'Windows line endings',
    summary: ' 3 pass\r\n 1 skip\r\n 0 fail\r\nRan 4 tests across 1 file. [8.00ms]\r\n',
    allowed: 1,
    line: '4 tests across 1 file, 1 skipped',
  },
  {
    label: 'files holding no test',
    summary: ' 0 pass\n 0 fail\nRan 0 tests across 2 files. [5.00ms]\n',
    refused: 'ran no test',
  },
  { label: 'no summary at all', summary: 'error: something else\n', refused: 'ran no test' },
  {
    label: 'every test skipped',
    summary: ' 0 pass\n 3 skip\n 0 fail\nRan 3 tests across 1 file. [5.00ms]\n',
    refused: 'skipped every one of its 3 tests',
  },
  {
    label: 'every test skipped or left to do',
    summary: ' 0 pass\n 4 skip\n 1 todo\n 0 fail\nRan 5 tests across 1 file. [5.00ms]\n',
    refused: 'skipped every one of its 5 tests',
  },
  {
    label: 'a name pattern leaving tests out',
    summary: ' 1 pass\n 2 filtered out\n 0 fail\nRan 1 test across 1 file. [5.00ms]\n',
    refused: 'left 2 tests out through a name pattern',
  },
  {
    label: 'a colored summary, as FORCE_COLOR gives',
    allowed: 1,
    summary: `${colored(' 1 pass')}\n ${colored('1 skip')}\n${colored(' 0 fail')}\nRan 2 tests across 1 file. ${ESC}[2m[${ESC}[1m5.00ms${ESC}[0m${ESC}[2m]${ESC}[0m\n`,
    line: '2 tests across 1 file, 1 skipped',
  },
  {
    label: 'a forged Ran line on stdout over files holding no test',
    summary: ' 0 pass\n 0 fail\nRan 0 tests across 2 files. [5.00ms]\n',
    stdout: 'bun test v9.8.7\nRan 9 tests across 2 files.\n',
    refused: 'ran no test',
  },
  {
    label: 'a forged Ran line and skip line on stderr above bun test own block',
    summary:
      '\na.test.ts:\nRan 9 tests across 2 files.\n 0 skip\n\n 0 pass\n 2 skip\n 0 fail\nRan 2 tests across 2 files.\n',
    refused: 'skipped every one of its 2 tests',
  },
  {
    label: 'a forged skip line printed by a test on stdout',
    summary: ' 0 pass\n 2 skip\n 0 fail\nRan 2 tests across 2 files. [5.00ms]\n',
    stdout: ' 0 skip\n',
    refused: 'skipped every one of its 2 tests',
  },
  {
    label: 'counts that do not add up to the Ran line',
    summary: ' 1 pass\n 0 fail\nRan 3 tests across 1 file. [5.00ms]\n',
    refused: 'do not add up to the 3 tests',
  },
  {
    label: 'a failed test',
    summary: ' 1 pass\n 1 fail\nRan 2 tests across 1 file. [5.00ms]\n',
    refused: 'failed 1 of its 2 tests',
  },
];

test.each([...COUNTS])('$label', ({ summary, stdout, allowed, line, refused }: CountCase) => {
  if (line !== undefined) {
    expect(testCount('bun test', ended(summary, stdout), allowed ?? 0)).toBe(line);
  } else {
    expect(() => testCount('bun test', ended(summary, stdout), allowed ?? 0)).toThrow(refused ?? '');
  }
});

/* ///// What the workflows and toml rows' tools report checking ///// */

test.each([
  ['plain', 'INFO taplo:format_files: found files total=2 excluded=0 files=["a.toml", "docs\\\\b \\"c\\".toml"]'],
  [
    'colored',
    `${ESC}[32m INFO${ESC}[0m ${ESC}[2mtaplo:format_files${ESC}[0m${ESC}[2m:${ESC}[0m found files ${ESC}[3mtotal${ESC}[0m${ESC}[2m=${ESC}[0m2 ${ESC}[3mexcluded${ESC}[0m${ESC}[2m=${ESC}[0m0 ${ESC}[3mfiles${ESC}[0m${ESC}[2m=${ESC}[0m["a.toml", "docs\\\\b \\"c\\".toml"]`,
  ],
])("taplo's %s found-files line gives every path, unescaped", (_label: string, line: string) => {
  expect(taploFound(`starting\n${line}\r\n`)).toEqual(['a.toml', 'docs\\b "c".toml']);
});

test('taplo output with no found-files line gives undefined', () => {
  expect(taploFound('INFO taplo: nothing to do\n')).toBeUndefined();
});

test.each([
  [
    'plain',
    'verbose: Found total 0 errors in 3 ms for .github/workflows/ci.yml\r\nFound total 1 error in 2 ms for .github/workflows/cd.yml\n',
  ],
  [
    'colored, with a prefix doubled',
    `${colored('verbose: ')}verbose: Found total 0 errors in 3 ms for ${colored('.github/workflows/ci.yml')}\nFound total 1 error in 2 ms for .github/workflows/cd.yml\n`,
  ],
])("actionlint's %s per-file lines give each file it finished", (_label: string, stderr: string) => {
  expect(actionlintFinished(stderr)).toEqual(new Set(['.github/workflows/ci.yml', '.github/workflows/cd.yml']));
});

test.each([
  [
    'plain',
    ' INFO audit: zizmor: completed .github\\workflows\\ci.yml\r\n INFO audit: zizmor: completed .github/dependabot.yml\n',
  ],
  [
    'colored',
    `${colored(' INFO')} audit: zizmor: completed ${colored('.github\\workflows\\ci.yml')}\n${colored(' INFO')} audit: zizmor: completed .github/dependabot.yml\n`,
  ],
])("zizmor's %s completed lines give each input with forward slashes", (_label: string, stderr: string) => {
  expect(zizmorCompleted(stderr)).toEqual(new Set(['.github/workflows/ci.yml', '.github/dependabot.yml']));
});

/* ///// Typecheck coverage ///// */

test('a tracked TypeScript file no project read is named, and one read is not', () => {
  const read = new Set([comparable('src/a.ts')]);

  expect(unreadSourceFinding(['src/a.ts', 'src/b.ts', 'README.md'], read)).toEqual(
    carrying('no project reads "src/b.ts", so tsc never reads it'),
  );
});

test.each(['x.ts', 'x.mts', 'x.cts', 'x.tsx', 'x.d.ts', 'X.TS'])('%p counts as a TypeScript source', (path: string) => {
  expect(unreadSourceFinding([path], new Set())).toEqual(carrying(JSON.stringify(path)));
});

test('every tracked TypeScript file read yields nothing', () => {
  expect(unreadSourceFinding(['src/a.ts', 'docs/b.md'], new Set([comparable('src/a.ts')]))).toBeUndefined();
});

/* ///// The compiler the typecheck row runs ///// */

// Versions no package.json pins, so a search for a real pin finds the pin file alone.
const PINNED = 'npm:typescript@9.1.2';

test.each([
  ['the pinned major', 'Version 9.1.2\n', PINNED],
  ['another minor of the pinned major', 'Version 9.4.0\r\n', PINNED],
  ['the pinned major in color', `${colored('Version 9.1.2')}\n`, PINNED],
  ['a plain version pin', 'Version 9.1.2\n', '9.1.2'],
])('%s passes', (_label: string, printed: string, spec: string) => {
  expect(compilerFinding(printed, spec)).toBeUndefined();
});

test.each([
  ["another package's compiler", 'Version 8.3.1\n', PINNED, 'printed "Version 8.3.1", and package.json pins major 9'],
  ['no version line', 'error TS5083: Cannot read file\n', PINNED, 'package.json pins major 9'],
  ['a pin naming no version', 'Version 9.1.2\n', 'npm:typescript@latest', 'which names no version'],
])('%s is a finding', (_label: string, printed: string, spec: string, fragment: string) => {
  expect(compilerFinding(printed, spec)).toEqual(carrying(fragment));
});

/* ///// What the lint row concludes from ESLint ///// */

// ESLint lints each case in this process with the comment rules the
// repository sets, once reading every comment and once with none read as a
// directive or configuration, as the row's two passes do. The json each pass
// prints is what lintedAsWritten and lintedWithoutComments read.

/** The repository root, where the probe file each case is linted as would sit. */
const ROOT = join(import.meta.dir, '..');

/** The file each case's text is linted as. */
const PROBE = join(ROOT, 'probe.ts');

// Built from its code point, so no invisible character is written into this file.
const WORD_JOINER = String.fromCodePoint(0x2060);

/**
 * The rules eslint.config.ts sets on a comment, and a rule for a waiver to
 * turn off, with no type information, since each case is text that no
 * project holds.
 */
const LINT_CONFIG = defineConfig(comments.recommended, {
  files: ['**/*.ts'],
  languageOptions: { parser: tseslint.parser },
  plugins: { gate: gatePlugin, '@typescript-eslint': tseslint.plugin },
  rules: {
    'gate/visible-reason': 'error',
    '@eslint-community/eslint-comments/require-description': 'error',
    '@eslint-community/eslint-comments/no-use': [
      'error',
      { allow: ['eslint-disable', 'eslint-enable', 'eslint-disable-line', 'eslint-disable-next-line'] },
    ],
    '@typescript-eslint/ban-ts-comment': ['error', { minimumDescriptionLength: 10 }],
    'no-debugger': 'error',
  },
});

const asWritten = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: LINT_CONFIG });
const noInline = new ESLint({
  cwd: ROOT,
  overrideConfigFile: true,
  overrideConfig: LINT_CONFIG,
  allowInlineConfig: false,
});

/** ESLint's json over `text` from `linter`, exiting 1 when it reports a problem, as its command line does. */
async function linted(linter: ESLint, text: string): Promise<Finished> {
  const results = await linter.lintText(text, { filePath: PROBE });
  const formatter = await linter.loadFormatter('json');
  return {
    exitCode: results.some((result) => result.messages.length > 0) ? 1 : 0,
    stdout: await formatter.format(results),
    stderr: '',
    heldOpen: false,
  };
}

/** What the lint row ends with over `text`: `passed <line>`, or the message it throws. */
async function lintRow(text: string): Promise<string> {
  const [first, second] = [await linted(asWritten, text), await linted(noInline, text)];
  try {
    return `passed ${lintedWithoutComments(second, lintedAsWritten(first))}`;
  } catch (error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The first pass's refusal of a gate/visible-reason report a directive turned off, at `line` and `column`. */
const turnedOff = (line: number, column: number): string =>
  `${quote(PROBE)}:${String(line)}:${String(column)}  a directive turned off gate/visible-reason, which no directive may do. Take the rule out of the directive and give each waiver a reason in words`;

/** The second pass's refusal of a report from `rule`, at `line` and `column`, saying `message`. */
const unwaived = (line: number, column: number, rule: string, message: string): string =>
  `${quote(PROBE)}:${String(line)}:${String(column)}  ${rule} reports this with every directive and configuration comment ignored, and no comment may turn that rule off: ${message}`;

/** The first pass's refusal of the one directive comment at `line` that no-use allows none of. */
const directiveRefused = (line: number): string =>
  `eslint exited 1 over 1 file:\n${quote(PROBE)}:${String(line)}:0  error  Unexpected ESLint directive comment.  @eslint-community/eslint-comments/no-use`;

const NO_USE = '@eslint-community/eslint-comments/no-use';

test.each([
  [
    'a disable-line naming the gate rule beside the one it waives, with an invisible reason',
    `debugger; // eslint-disable-line no-debugger, gate/visible-reason -- ${WORD_JOINER}\n`,
    turnedOff(1, 11),
  ],
  [
    'a block disable naming the gate rule, closed by an enable with a reason in words, and a waiver between them',
    `/* eslint-disable gate/visible-reason -- ${WORD_JOINER} */\n// eslint-disable-next-line no-debugger -- ${WORD_JOINER}\ndebugger;\n/* eslint-enable gate/visible-reason -- restore the rule */\n`,
    [turnedOff(1, 1), turnedOff(2, 1)].join('\n'),
  ],
  [
    'a configuration comment turning the gate rule off for its file',
    `/* eslint gate/visible-reason: "off" -- the rule stays off in this file */\n// eslint-disable-next-line no-debugger -- ${WORD_JOINER}\ndebugger;\n`,
    directiveRefused(1),
  ],
  [
    'a configuration comment turning off a rule that reads no comments',
    '/* eslint no-debugger: "off" -- this file steps through the gate by hand */\ndebugger;\n',
    directiveRefused(1),
  ],
  [
    'a global declared in a comment',
    '/* global probe -- a global the runtime declares */\nexport const value: unknown = probe;\n',
    directiveRefused(1),
  ],
  [
    'globals declared in a comment',
    '/* globals probe -- a global the runtime declares */\nexport const value: unknown = probe;\n',
    directiveRefused(1),
  ],
  [
    'an exported comment',
    '/* exported value -- another file reads it */\nexport const value = 1;\n',
    directiveRefused(1),
  ],
  [
    'an eslint-env comment, which ESLint refuses beside no-use',
    '/* eslint-env node -- the file runs under node */\nexport const value = 1;\n',
    `${directiveRefused(1)}\n${quote(PROBE)}:1:1  error  /* eslint-env */ comments are no longer supported.  `,
  ],
  [
    'a configuration comment turning no-use off before one setting a rule',
    '/* eslint @eslint-community/eslint-comments/no-use: "off" -- the rule stays off */\n/* eslint no-debugger: "off" -- the file steps through by hand */\ndebugger;\n',
    [
      unwaived(1, 0, NO_USE, 'Unexpected ESLint directive comment.'),
      unwaived(2, 0, NO_USE, 'Unexpected ESLint directive comment.'),
    ].join('\n'),
  ],
  [
    'a block disable of no-use around a configuration comment',
    '/* eslint-disable @eslint-community/eslint-comments/no-use -- a block of settings */\n/* eslint no-debugger: "off" -- the file steps through by hand */\n/* eslint-enable @eslint-community/eslint-comments/no-use -- the block ends */\ndebugger;\n',
    unwaived(2, 0, NO_USE, 'Unexpected ESLint directive comment.'),
  ],
])('%s is refused, naming each report', async (_label: string, text: string, refusal: string) => {
  expect(await lintRow(text)).toBe(refusal);
});

test.each([
  ['a next-line directive', '// eslint-disable-next-line no-debugger -- stepped through by hand\ndebugger;\n', 2],
  ['a disable-line directive', 'debugger; // eslint-disable-line no-debugger -- stepped through by hand\n', 1],
  [
    'a block pair',
    '/* eslint-disable no-debugger -- the block steps through by hand */\ndebugger;\n/* eslint-enable no-debugger -- the block ends here */\n',
    2,
  ],
  [
    'a block next-line directive',
    '/* eslint-disable-next-line no-debugger -- stepped through by hand */\ndebugger;\n',
    2,
  ],
  ['a block disable-line directive', 'debugger; /* eslint-disable-line no-debugger -- stepped through by hand */\n', 1],
  [
    'a block pair whose reason starts on the next line',
    '/* eslint-disable no-debugger --\n   the reason on its own line */\ndebugger;\n/* eslint-enable no-debugger -- the pair */\n',
    3,
  ],
])(
  '%s with a reason in words passes both passes, though the second reports the rule it waives',
  async (_label: string, text: string, line: number) => {
    const second: unknown = JSON.parse((await linted(noInline, text)).stdout);

    expect(second).toMatchObject([{ messages: [{ ruleId: 'no-debugger', line }] }]);
    expect(await lintRow(text)).toBe('passed 1 file');
  },
);

test('a @ts-expect-error with a description in words passes both passes', async () => {
  expect(
    await lintRow(
      "// @ts-expect-error the fixture assigns a string to a number\nexport const count: number = 'text';\n",
    ),
  ).toBe('passed 1 file');
});

// A file name can hold the one-byte CSI before each quote. JSON writes such a
// quote as a backslash and a quote, and a CSI strip ahead of the parse eats
// the backslash, so the name would close its string and inject json tokens.
// The names below would nest x's second-pass report under an injected key.
test('a file name built to rewrite the json after a control-sequence strip leaves the second pass intact', () => {
  const csi = String.fromCharCode(0x9b);
  const smuggle = (text: string): string => text.replaceAll('"', `${csi}"`);
  const x = `/abs/src/${smuggle('a","messages":[],"suppressedMessages":[],"hide":[{"k":"')}/x.ts`;
  const y = `/abs/src/${smuggle('b"}],"q":"')}/y.ts`;
  const report = { ruleId: NO_USE, severity: 2, message: 'Unexpected ESLint directive comment.', line: 2, column: 0 };
  const first = printed([
    { filePath: x, messages: [], suppressedMessages: [report] },
    { filePath: y, messages: [], suppressedMessages: [] },
  ]);
  const second = printed(
    [
      { filePath: x, messages: [report], suppressedMessages: [] },
      { filePath: y, messages: [], suppressedMessages: [] },
    ],
    1,
  );

  expect(() => lintedWithoutComments(second, lintedAsWritten(first))).toThrow(
    `${quote(x)}:2:0  ${NO_USE} reports this with every directive and configuration comment ignored, and no comment may turn that rule off: Unexpected ESLint directive comment.`,
  );
});

test('a control sequence in a message prints stripped', () => {
  const esc = String.fromCharCode(0x1b);
  const first = printed(
    [
      {
        filePath: PROBE,
        messages: [{ ruleId: 'no-debugger', severity: 2, message: `${esc}[31mred${esc}[0m`, line: 1, column: 1 }],
        suppressedMessages: [],
      },
    ],
    1,
  );

  expect(() => lintedAsWritten(first)).toThrow(`${quote(PROBE)}:1:1  error  red  no-debugger`);
});

/** One pass's printed json: `results` as ESLint's json formatter writes them. */
function printed(results: unknown, exitCode = 0, stderr = ''): Finished {
  return { exitCode, stdout: JSON.stringify(results), stderr, heldOpen: false };
}

/** One clean file result for `path`. */
const clean = (path: string): unknown => ({ filePath: path, messages: [], suppressedMessages: [] });

test.each([
  [
    'json whose results list no suppressed reports',
    printed([{ filePath: PROBE, messages: [] }]),
    'eslint printed json that is not a list of file results',
  ],
  [
    'no json at all',
    { exitCode: 2, stdout: '', stderr: 'config error', heldOpen: false },
    'eslint exited 2 saying: config error',
  ],
  ['no file linted', printed([]), 'eslint linted no file, so it checked nothing'],
])('a first pass printing %s is refused', (_label: string, first: Finished, refusal: string) => {
  expect(() => lintedAsWritten(first)).toThrow(refusal);
});

test.each([
  [
    'lints no file',
    printed([]),
    'eslint --no-inline-config linted 0 files and the first pass 1 file, not the same ones',
  ],
  [
    'lints another file',
    printed([clean(join(ROOT, 'other.ts'))], 1),
    'eslint --no-inline-config linted 1 file and the first pass 1 file, not the same ones',
  ],
  ['exits 2', printed([clean(PROBE)], 2, 'crashed'), 'eslint --no-inline-config exited 2 saying:'],
  [
    'prints no json',
    { exitCode: 1, stdout: '', stderr: 'crashed', heldOpen: false },
    'eslint --no-inline-config exited 1 saying: crashed',
  ],
])('a second pass that %s is refused', (_label: string, second: Finished, refusal: string) => {
  expect(() => lintedWithoutComments(second, [{ filePath: PROBE, messages: [], suppressedMessages: [] }])).toThrow(
    refusal,
  );
});

/* ///// Prettier ignore comments ///// */

// The comment is spelled from pieces here, since this file is one the format
// row checks.
const IGNORE = ['prettier', 'ignore'].join('-');

// Every form the pinned Prettier honors, measured per parser, and forms it does
// not honor that the match still refuses.
test.each([
  `// ${IGNORE}`,
  `//${IGNORE}`,
  `//\t${IGNORE}`,
  `//${String.fromCharCode(0xa0)}${IGNORE}`,
  `/* ${IGNORE} */`,
  `/** ${IGNORE} */`,
  `const a = /* ${IGNORE} */ [1];`,
  `<!-- ${IGNORE} -->`,
  `<!--${IGNORE}-->`,
  `<!-- ${IGNORE}-start -->`,
  `<!-- ${IGNORE}-attribute -->`,
  `# ${IGNORE}`,
  `#${IGNORE}`,
  `{/* ${IGNORE} */}`,
  `{{! ${IGNORE} }}`,
  `{{!-- ${IGNORE} --}}`,
  `{{!--${IGNORE}--}}`,
  `// ${IGNORE.toUpperCase()}`,
  `/// ${IGNORE}`,
])('%p is refused, naming the file and line', (comment: string) => {
  expect(ignoreCommentFindings('src/a.ts', `const a = 1;\n${comment}\nconst b = 2;\n`)).toEqual([
    carrying('"src/a.ts" line 2 carries a Prettier ignore comment'),
  ]);
});

test.each([
  [`/*\n  ${IGNORE}\n*/`, 3],
  [`/**\n * ${IGNORE}\n */`, 3],
  [`<!--\n${IGNORE}\n-->`, 3],
])('a comment spanning lines, %p, is refused at the line carrying the keyword', (comment: string, line: number) => {
  expect(ignoreCommentFindings('docs/a.md', `# T\n${comment}\n`)).toEqual([
    carrying(`"docs/a.md" line ${String(line)} carries a Prettier ignore comment`),
  ]);
});

test('two comments in one file are two findings', () => {
  expect(ignoreCommentFindings('a.yml', `# ${IGNORE}\na: 1\n# ${IGNORE}\nb: 2\n`)).toEqual([
    carrying('"a.yml" line 1 carries'),
    carrying('"a.yml" line 3 carries'),
  ]);
});

test.each([
  'const prettier = 1; // ignore this',
  `The format row refuses Prettier's \`${IGNORE}\` comment.`,
  `Prettier's ${IGNORE} comment leaves code unformatted.`,
  `const reason = 'no ${IGNORE} here';`,
  `See ${IGNORE}-start and ${IGNORE}-end in the docs.`,
  `## The ${IGNORE} rule`,
  `// @${IGNORE}`,
  `//! ${IGNORE}`,
])('%p names no comment Prettier honors and yields nothing', (text: string) => {
  expect(ignoreCommentFindings('docs/a.md', `${text}\n`)).toEqual([]);
});
