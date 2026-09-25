/**
 * The gate's own ESLint rule, which eslint.config.ts loads as the `gate`
 * plugin.
 *
 * @remarks
 * The rule reads the comments ESLint parsed, so a string or a template that
 * holds comment text is never read as a comment, and a comment is never
 * missed for the text around it. The module imports types alone, so loading
 * it runs no other code.
 */

import type { ESLint, Rule } from 'eslint';

/** Every code point Unicode lists as default-ignorable, none of which prints. */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/** A letter or a digit, in any script. */
const WORD = /[\p{L}\p{N}]/u;

/** What ESLint splits a directive comment's reason from the directive at: two or more hyphens between whitespace. */
const REASON_SEPARATOR = /\s-{2,}\s/u;

/** Every directive ESLint reads from the start of a comment, as ESLint's own pattern lists them. */
const ESLINT_DIRECTIVE = /^(eslint(?:-env|-enable|-disable(?:(?:-next)?-line)?)?|exported|globals?)(?:\s|$)/u;

/** The directives ESLint reads from a line comment. It reads every other one from a block comment alone. */
const LINE_DIRECTIVE = /^eslint-disable-(?:next-)?line$/u;

/**
 * tsc's patterns for a waiver in a line comment's text and on a block
 * comment's last line, as ban-ts-comment copies them. The reason is all that
 * follows the directive's name.
 */
const TS_LINE = /^\/*\s*@(ts-(?:expect-error|ignore))(.*)/u;
const TS_BLOCK = /^\s*(?:\/|\*)*\s*@(ts-(?:expect-error|ignore))(.*)/u;

/** Every line break tsc and ban-ts-comment split a block comment at. */
const LINE_BREAK = /\r\n|[\r\n\p{Zl}\p{Zp}]/u;

/** A waiver a comment holds: the directive's name, and the reason it gives, empty when it gives none. */
interface Waiver {
  readonly directive: string;
  readonly reason: string;
}

/**
 * The waiver in the comment of `type` whose text is `value`, or undefined
 * when ESLint and tsc read none there.
 *
 * @remarks
 * ESLint splits the reason off first, at the first {@link REASON_SEPARATOR},
 * then reads the directive from what comes before it.
 */
function waiverIn(type: string, value: string): Waiver | undefined {
  const ts = type === 'Line' ? TS_LINE.exec(value) : TS_BLOCK.exec(value.split(LINE_BREAK).at(-1) ?? '');
  if (ts !== null) {
    return { directive: `@${ts[1] ?? ''}`, reason: ts[2] ?? '' };
  }
  const separator = REASON_SEPARATOR.exec(value);
  const directive = ESLINT_DIRECTIVE.exec((separator === null ? value : value.slice(0, separator.index)).trim())?.[1];
  if (directive === undefined || (type === 'Line' && !LINE_DIRECTIVE.test(directive))) {
    return undefined;
  }
  return { directive, reason: separator === null ? '' : value.slice(separator.index + separator[0].length) };
}

/**
 * Every ESLint directive and every `@ts-expect-error` or `@ts-ignore` gives
 * a reason holding a letter or a digit once default-ignorable code points
 * are removed.
 *
 * @remarks
 * eslint-comments' require-description and ban-ts-comment accept a reason
 * made only of characters that print nothing, such as U+00AD or U+2800, or
 * of symbols alone. U+3164 is default-ignorable though Unicode files it as a
 * letter, so the strip comes before the test. The rule holds a reason to a
 * letter or a digit and to nothing more: a letter some fonts draw blank, such
 * as U+13441, passes.
 */
export const visibleReason: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require every ESLint directive and TypeScript waiver comment to give a reason holding a letter or a digit once default-ignorable code points are removed',
    },
    schema: [],
    messages: {
      invisible:
        'This {{directive}} comment gives no reason holding a letter or a digit once the characters that print nothing are removed. Write the reason in words.',
    },
  },
  create(context: Rule.RuleContext): Rule.RuleListener {
    return {
      Program(): void {
        for (const comment of context.sourceCode.getAllComments()) {
          const waiver = waiverIn(comment.type, comment.value);
          if (waiver !== undefined && !WORD.test(waiver.reason.replace(IGNORABLE, ''))) {
            context.report({ node: comment, messageId: 'invisible', data: { directive: waiver.directive } });
          }
        }
      },
    };
  },
};

/** The plugin eslint.config.ts registers as `gate`. */
export const gatePlugin: ESLint.Plugin = {
  rules: { 'visible-reason': visibleReason },
};
