/**
 * Stands in for ShellCheck under actionlint's `-shellcheck` flag, so a
 * ShellCheck directive in a workflow script is refused in the text ShellCheck
 * itself reads.
 *
 * @remarks
 * The workflows row starts actionlint with `-shellcheck` naming the Bun that
 * runs the gate, this file and the pinned ShellCheck. actionlint adds
 * ShellCheck's own arguments and writes each script to stdin as ShellCheck
 * reads it: YAML escapes and folding decoded and every `${{ }}` expression
 * blanked. A line carrying `#`, any spacing, then `shellcheck` and a space, in
 * any case, is refused as a finding in ShellCheck's JSON form, so actionlint
 * prints it beside the step and the row fails. Any other script runs through
 * the pinned ShellCheck unchanged, with its stderr and exit code passed
 * through, and its stdout once it read the whole script and exited 0 or 1.
 * Nothing reaches stdout before the script was read whole and ShellCheck
 * exited. The file is the same in every repository of the set and imports
 * nothing, so actionlint starting it once per script loads no other module.
 * Any failure here exits 2 with nothing on stdout, which actionlint reports as
 * a failed run rather than a clean one.
 */

/** ShellCheck's JSON form of one finding, as `shellcheck -f json` prints it. */
interface Finding {
  readonly file: string;
  readonly line: number;
  readonly endLine: number;
  readonly column: number;
  readonly endColumn: number;
  readonly level: 'error';
  readonly code: number;
  readonly message: string;
  readonly fix: null;
}

// ShellCheck reads a directive as `#`, any spacing, `shellcheck`, then at least
// one space. Its spacing is a space, a tab or one of eleven Unicode spaces,
// and \s covers all of them but the zero-width space, which is added here. The
// case is folded, which only widens the match.
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);
const DIRECTIVE = new RegExp(`#[\\s${ZERO_WIDTH_SPACE}]*shellcheck[\\s${ZERO_WIDTH_SPACE}]`, 'i');

/** The variable ShellCheck reads extra flags from, one of which can exclude any finding. */
const OPTIONS_VARIABLE = 'SHELLCHECK_OPTS';

/** Whether `path` is absolute on Windows or POSIX, read without importing node:path. */
function isAbsolutePath(path: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|[\\/])/.test(path);
}

/** A finding for every line of `script` carrying a ShellCheck directive, numbered from 1. */
function directives(script: string): Finding[] {
  return script.split('\n').flatMap((text, index) =>
    DIRECTIVE.test(text)
      ? [
          {
            file: '-',
            line: index + 1,
            endLine: index + 1,
            column: 1,
            endColumn: 1,
            level: 'error' as const,
            code: 0,
            message: `A ShellCheck directive is refused in a workflow script, so rewrite the script until ShellCheck passes it: ${JSON.stringify(text.trim().slice(0, 200))}`,
            fix: null,
          },
        ]
      : [],
  );
}

async function main(): Promise<number> {
  const [shellcheck = '', ...args] = process.argv.slice(2);
  if (!isAbsolutePath(shellcheck)) {
    throw new Error(`the first argument names ShellCheck by an absolute path, and it is ${JSON.stringify(shellcheck)}`);
  }
  const script = new Uint8Array(await Bun.stdin.arrayBuffer());
  const refused = directives(new TextDecoder().decode(script));
  if (refused.length > 0) {
    await pass(Bun.stdout, new TextEncoder().encode(JSON.stringify(refused)));
    return 1;
  }
  for (const name of Object.keys(process.env)) {
    if (name.toUpperCase() === OPTIONS_VARIABLE) {
      Reflect.deleteProperty(process.env, name);
    }
  }
  const child = Bun.spawn({
    cmd: [shellcheck, ...args],
    env: { ...process.env },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  // The script is written on its own task while both outputs are read, so
  // neither side waits on a full pipe. A ShellCheck that exits before reading
  // the script leaves the write failing with EPIPE once the pipe is full.
  const written = (async (): Promise<string | undefined> => {
    try {
      await child.stdin.write(script);
      await child.stdin.end();
      return undefined;
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  const [unwritten, stdout, stderr, exitCode] = await Promise.all([
    written,
    new Response(child.stdout).bytes(),
    new Response(child.stderr).bytes(),
    child.exited,
  ]);
  await pass(Bun.stderr, stderr);
  if (unwritten !== undefined) {
    throw new Error(`ShellCheck did not read the whole script: ${unwritten}`);
  }
  if (child.signalCode !== null) {
    throw new Error(`ShellCheck ended on ${child.signalCode} rather than an exit code`);
  }
  // ShellCheck exits 0 or 1 when it read and checked the script. Any other
  // exit keeps its stdout back, since actionlint reads a failed run with
  // findings on stdout as those findings alone, and `[]` as a clean one.
  if (exitCode === 0 || exitCode === 1) {
    await pass(Bun.stdout, stdout);
  }
  return exitCode;
}

/** Writes `bytes` to `stream` unless there are none, since Bun fails an empty write to a Windows pipe. */
async function pass(stream: typeof Bun.stdout, bytes: Uint8Array): Promise<void> {
  if (bytes.length > 0) {
    await Bun.write(stream, bytes);
  }
}

try {
  process.exitCode = await main();
} catch (error: unknown) {
  console.error(`the ShellCheck stand-in failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 2;
}

// Bun 1.4.2 ends a file with no import or export before its read of stdin
// settles, exit 0 with nothing printed, so the empty export makes this file a
// module that waits on the await above.
export {};
