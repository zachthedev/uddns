import { expect, setDefaultTimeout, test } from 'bun:test';
import { join } from 'node:path';
import comments from '@eslint-community/eslint-plugin-eslint-comments/configs';
import { ESLint } from 'eslint';
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import { gatePlugin } from './eslint-plugin';

// Loading typescript-eslint and the repository's config takes seconds on a cold cache.
setDefaultTimeout(30_000);

/** The repository root, where eslint.config.ts sits. */
const ROOT = join(import.meta.dir, '..');

// Each character is built from its code point, so none is written into this file.
const character = (codePoint: number): string => String.fromCodePoint(codePoint);
const SOFT_HYPHEN = character(0xad);
const WORD_JOINER = character(0x2060);
const BRAILLE_BLANK = character(0x2800);
const HANGUL_FILLER = character(0x3164);

/**
 * The rules a waiver in the cases turns off, the two that check a waiver's
 * reason as the repository configures them, and the gate's rule, with no type
 * information, since each case is text that no project holds.
 */
const CONFIG = defineConfig(comments.recommended, {
  files: ['**/*.ts'],
  languageOptions: { parser: tseslint.parser },
  plugins: { gate: gatePlugin, '@typescript-eslint': tseslint.plugin },
  rules: {
    'gate/visible-reason': 'error',
    '@eslint-community/eslint-comments/require-description': 'error',
    '@typescript-eslint/ban-ts-comment': ['error', { minimumDescriptionLength: 10 }],
    '@typescript-eslint/no-explicit-any': 'error',
    'no-debugger': 'error',
    'no-undef': 'error',
  },
});

const eslint = new ESLint({ cwd: ROOT, overrideConfigFile: true, overrideConfig: CONFIG });

/**
 * Every problem ESLint reports over `text` as a TypeScript file, as its line
 * and rule in sorted order, and the gate rule's messages.
 */
async function problems(text: string): Promise<{ readonly found: string[]; readonly messages: string[] }> {
  const [result] = await eslint.lintText(text, { filePath: join(ROOT, 'probe.ts') });
  const reported = result?.messages ?? [{ line: 0, ruleId: 'no result', message: '' }];
  return {
    found: reported.map((message) => `${String(message.line)} ${message.ruleId ?? 'no rule'}`).sort(),
    messages: reported.filter((message) => message.ruleId === 'gate/visible-reason').map((message) => message.message),
  };
}

/** The gate rule's message for a waiver whose directive is `directive`. */
const refusal = (directive: string): string =>
  `This ${directive} comment gives no reason holding a letter or a digit once the characters that print nothing are removed. Write the reason in words.`;

test.each([
  [
    'a line directive whose reason is a soft hyphen',
    `// eslint-disable-next-line no-debugger -- ${SOFT_HYPHEN}\ndebugger;\n`,
    1,
    'eslint-disable-next-line',
  ],
  [
    'a block directive after a string holding a line comment opener',
    `export const home = 'https://example.invalid'; /* eslint-disable-next-line no-debugger -- ${SOFT_HYPHEN} */\ndebugger;\n`,
    1,
    'eslint-disable-next-line',
  ],
  [
    "a line directive between strings holding a block comment's open and close",
    `export const open = '/*';\n// eslint-disable-next-line no-debugger -- ${SOFT_HYPHEN}\ndebugger;\nexport const close = '*/';\n`,
    2,
    'eslint-disable-next-line',
  ],
  [
    'a reason of U+2800, which is neither whitespace nor default-ignorable',
    `// eslint-disable-next-line no-debugger -- ${BRAILLE_BLANK}\ndebugger;\n`,
    1,
    'eslint-disable-next-line',
  ],
  ['a rule-config comment', `/* eslint no-debugger: "off" -- ${SOFT_HYPHEN} */\ndebugger;\n`, 1, 'eslint'],
  [
    'a @ts-expect-error of ten soft hyphens',
    `// @ts-expect-error ${SOFT_HYPHEN.repeat(10)}\nexport const count: number = 'text';\n`,
    1,
    '@ts-expect-error',
  ],
  [
    'a disable-line after a string holding a line comment opener',
    `export const home: any = 'https://example.invalid'; // eslint-disable-line @typescript-eslint/no-explicit-any -- ${SOFT_HYPHEN}\n`,
    1,
    'eslint-disable-line',
  ],
  [
    'a reason of a zero-width space',
    `// eslint-disable-next-line no-debugger -- ${character(0x200b)}\ndebugger;\n`,
    1,
    'eslint-disable-next-line',
  ],
  [
    'a reason of U+3164, which Unicode files as a letter',
    `// eslint-disable-next-line no-debugger -- ${HANGUL_FILLER}\ndebugger;\n`,
    1,
    'eslint-disable-next-line',
  ],
  [
    'a reason of symbols alone',
    '// eslint-disable-next-line no-debugger -- ...!\ndebugger;\n',
    1,
    'eslint-disable-next-line',
  ],
  [
    'an enable closing a disable',
    `/* eslint-disable no-debugger -- the pair */\ndebugger;\n/* eslint-enable no-debugger -- ${WORD_JOINER} */\n`,
    3,
    'eslint-enable',
  ],
  ['a global declaration', `/* global probe -- ${SOFT_HYPHEN} */\nexport const value: unknown = probe;\n`, 1, 'global'],
  [
    'a block @ts-expect-error of ten symbols',
    '/* @ts-expect-error .:;!?+=~^% */\nexport const count = 1;\n',
    1,
    '@ts-expect-error',
  ],
])(
  '%s is refused, and nothing else reports it',
  async (_label: string, text: string, line: number, directive: string) => {
    expect(await problems(text)).toEqual({
      found: [`${String(line)} gate/visible-reason`],
      messages: [refusal(directive)],
    });
  },
);

test('a directive with no reason is refused by the gate rule beside require-description', async () => {
  expect(await problems('// eslint-disable-next-line no-debugger\ndebugger;\n')).toEqual({
    found: ['1 @eslint-community/eslint-comments/require-description', '1 gate/visible-reason'],
    messages: [refusal('eslint-disable-next-line')],
  });
});

test('a @ts-ignore whose reason prints nothing is refused beside ban-ts-comment', async () => {
  expect(await problems(`// @ts-ignore ${SOFT_HYPHEN.repeat(10)}\nexport const count = 1;\n`)).toEqual({
    found: ['1 @typescript-eslint/ban-ts-comment', '1 gate/visible-reason'],
    messages: [refusal('@ts-ignore')],
  });
});

test.each([
  ['a reason in words', '// eslint-disable-next-line no-debugger -- the reason\ndebugger;\n'],
  [
    'a reason in words after an invisible mark',
    `// eslint-disable-next-line no-debugger -- ${WORD_JOINER}why\ndebugger;\n`,
  ],
  [
    'a reason in another script',
    `// eslint-disable-next-line no-debugger -- ${character(0x7406)}${character(0x7531)}\ndebugger;\n`,
  ],
  ['a reason naming an issue by number', '// eslint-disable-next-line no-debugger -- #42\ndebugger;\n'],
  [
    'a block reason on the next line',
    '/* eslint-disable no-debugger --\n   the reason */\ndebugger;\n/* eslint-enable no-debugger -- the pair */\n',
  ],
  [
    'a @ts-expect-error with a reason in words',
    '// @ts-expect-error the fixture is a string\nexport const count = 1;\n',
  ],
  [
    'comment text inside strings',
    `export const line = '// eslint-disable-next-line no-debugger -- ${SOFT_HYPHEN}';\nexport const block = '/* @ts-expect-error ${SOFT_HYPHEN.repeat(10)} */';\n`,
  ],
  [
    'a line comment ESLint reads no directive from',
    `// eslint-disable no-debugger -- ${SOFT_HYPHEN}\nexport const count = 1;\n`,
  ],
  ['prose naming a directive', `// Explains eslint-disable -- ${SOFT_HYPHEN}\nexport const count = 1;\n`],
])('%s passes', async (_label: string, text: string) => {
  expect(await problems(text)).toEqual({ found: [], messages: [] });
});

test.each(['src/example.ts', 'scripts/check.ts', 'tests/example.test.ts', 'eslint.config.ts', 'commitlint.config.js'])(
  'eslint.config.ts turns the gate rule on for %s',
  async (path: string) => {
    const repository = new ESLint({ cwd: ROOT, overrideConfigFile: join(ROOT, 'eslint.config.ts') });
    const config: unknown = await repository.calculateConfigForFile(join(ROOT, path));

    expect(config).toMatchObject({ rules: { 'gate/visible-reason': [2] } });
  },
);
