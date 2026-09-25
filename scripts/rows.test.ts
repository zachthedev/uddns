import { expect, test } from 'bun:test';
import {
  actionlintFinished,
  comparable,
  compilerFinding,
  ignoreCommentFindings,
  type InheritedCall,
  inheritedCallFindings,
  inheritedCalls,
  taploFound,
  testCount,
  unreadSourceFinding,
  zizmorCompleted,
} from './rows';
import { type Finished, plain, printable, quote } from './run';

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
  /** The row's line, or undefined when the count must throw. */
  readonly line?: string;
  /** A fragment the throw carries. */
  readonly refused?: string;
}

// Each summary is written the way Bun 1.4.2 prints it.
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
    label: 'some skipped, as on a platform a case does not run on',
    summary: ' 5 pass\n 2 skip\n 0 fail\nRan 7 tests across 2 files. [80.00ms]\n',
    line: '7 tests across 2 files, 2 skipped',
  },
  {
    label: 'Windows line endings',
    summary: ' 3 pass\r\n 1 skip\r\n 0 fail\r\nRan 4 tests across 1 file. [8.00ms]\r\n',
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
    summary: `${colored(' 1 pass')}\n ${colored('1 skip')}\n${colored(' 0 fail')}\nRan 2 tests across 1 file. ${ESC}[2m[${ESC}[1m5.00ms${ESC}[0m${ESC}[2m]${ESC}[0m\n`,
    line: '2 tests across 1 file, 1 skipped',
  },
  {
    label: 'a forged Ran line on stdout over files holding no test',
    summary: ' 0 pass\n 0 fail\nRan 0 tests across 2 files. [5.00ms]\n',
    stdout: 'bun test v1.4.2\nRan 9 tests across 2 files.\n',
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

test.each([...COUNTS])('$label', ({ summary, stdout, line, refused }: CountCase) => {
  if (line !== undefined) {
    expect(testCount('bun test', ended(summary, stdout))).toBe(line);
  } else {
    expect(() => testCount('bun test', ended(summary, stdout))).toThrow(refused ?? '');
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

const PINNED = 'npm:typescript@7.0.2';

test.each([
  ['the pinned major', 'Version 7.0.2\n', PINNED],
  ['another minor of the pinned major', 'Version 7.1.4\r\n', PINNED],
  ['the pinned major in color', `${colored('Version 7.0.2')}\n`, PINNED],
  ['a plain version pin', 'Version 7.0.2\n', '7.0.2'],
])('%s passes', (_label: string, printed: string, spec: string) => {
  expect(compilerFinding(printed, spec)).toBeUndefined();
});

test.each([
  ['the 6.x compiler', 'Version 6.0.3\n', PINNED, 'printed "Version 6.0.3", and package.json pins major 7'],
  ['no version line', 'error TS5083: Cannot read file\n', PINNED, 'package.json pins major 7'],
  ['a pin naming no version', 'Version 7.0.2\n', 'npm:typescript@latest', 'which names no version'],
])('%s is a finding', (_label: string, printed: string, spec: string, fragment: string) => {
  expect(compilerFinding(printed, spec)).toEqual(carrying(fragment));
});

/* ///// Prettier ignore comments ///// */

// The comment is spelled from pieces here, since this file is one the format
// row checks.
const IGNORE = ['prettier', 'ignore'].join('-');

// Every form Prettier 3.9.8 honors, measured per parser, and forms it does
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

/* ///// secrets: inherit ///// */

/** One finding in the shape zizmor 1.30 prints with --format json. */
function finding(ident: string, path: string, row: number, feature: string): unknown {
  return {
    ident,
    locations: [
      { symbolic: { kind: 'Related' }, concrete: { feature: 'secrets: inherit' } },
      {
        symbolic: { kind: 'Primary', key: { Local: { verbatim_path: path } } },
        concrete: { feature, location: { start_point: { row } } },
      },
    ],
  };
}

test('each secrets-inherit finding becomes its file, one-based line and unquoted callee, and other audits are skipped', () => {
  const report = [
    finding(
      'secrets-inherit',
      '.github\\workflows\\cd.yml',
      35,
      '"zachthedev/.github/.github/workflows/publish.yml@abc"',
    ),
    finding('unpinned-uses', '.github/workflows/ci.yml', 3, 'actions/checkout@v4'),
    finding('secrets-inherit', '.github/workflows/deps.yml', 32, "'zachthedev/.github/.github/workflows/deps.yml@abc'"),
  ];

  const calls = [
    { path: '.github/workflows/cd.yml', line: 36, callee: 'zachthedev/.github/.github/workflows/publish.yml@abc' },
    { path: '.github/workflows/deps.yml', line: 33, callee: 'zachthedev/.github/.github/workflows/deps.yml@abc' },
  ];
  expect(inheritedCalls(JSON.stringify(report))).toEqual(calls);
  expect(inheritedCalls(colored(JSON.stringify(report, null, 2).replaceAll('\n', '\r\n')))).toEqual(calls);
});

test.each(['', 'error: no input', '[{"ident": "secrets-inherit"'])(
  'zizmor printing %p throws, naming no json',
  (printed: string) => {
    expect(() => inheritedCalls(printed)).toThrow('zizmor printed no json');
  },
);

test.each([
  ['a report that is not a list', { findings: [] }, 'not a list of findings'],
  ['a finding with no primary location', [{ ident: 'secrets-inherit', locations: [] }], 'no primary file'],
  [
    'a finding with no callee',
    [
      {
        ident: 'secrets-inherit',
        locations: [{ symbolic: { kind: 'Primary', key: { Local: { verbatim_path: 'x' } } } }],
      },
    ],
    'no primary file',
  ],
  ['a null finding location', [{ ident: 'secrets-inherit', locations: [null] }], 'no primary file'],
])('%s throws', (_label: string, report: unknown, refused: string) => {
  expect(() => inheritedCalls(JSON.stringify(report))).toThrow(refused);
});

const HELD = ['zachthedev/.github/.github/workflows/'];

/** A call from `path` to `callee`, at line 10. */
function call(path: string, callee: string): InheritedCall {
  return { path, line: 10, callee };
}

test('calls to reusable workflows of zachthedev/.github, in any case, from every waived file yield nothing', () => {
  const calls = [
    call('.github/workflows/cd.yml', 'zachthedev/.github/.github/workflows/publish.yml@abc'),
    call('.github/workflows/deps.yml', 'ZachTheDev/.GitHub/.github/workflows/deps.yml@abc'),
  ];

  expect(inheritedCallFindings(calls, HELD, ['cd.yml', 'deps.yml'])).toEqual([]);
});

test.each([
  'someone/.github/.github/workflows/publish.yml@abc',
  'zachthedev/.github-fork/.github/workflows/publish.yml@abc',
  'zachthedev/other/.github/workflows/publish.yml@abc',
  './.github/workflows/local.yml',
  'zachthedev/.github/.github/workflowsx/publish.yml@abc',
])('a call to %p is refused, naming the file, line and callee', (callee: string) => {
  expect(inheritedCallFindings([call('.github/workflows/cd.yml', callee)], HELD, ['cd.yml'])).toEqual([
    carrying(`".github/workflows/cd.yml" line 10 passes secrets: inherit to ${JSON.stringify(callee)}`),
  ]);
});

test('a waived file holding no call is refused as stale, in the file form and the line form', () => {
  const calls = [call('.github/workflows/cd.yml', 'zachthedev/.github/.github/workflows/publish.yml@abc')];

  expect(inheritedCallFindings(calls, HELD, ['cd.yml', 'deps.yml', 'ci.yml:3:5'])).toEqual([
    carrying('the secrets-inherit waiver names "deps.yml", and zizmor reported no job there'),
    carrying('the secrets-inherit waiver names "ci.yml:3:5", and zizmor reported no job there'),
  ]);
});

test('no calls and no waivers yield nothing', () => {
  expect(inheritedCallFindings([], HELD, [])).toEqual([]);
});
