/**
 * Stand-ins for the programs the gate starts, for the tests beside this file.
 *
 * @remarks
 * Each stand-in records how it was started, its arguments and its whole
 * environment, and answers as the case says. While {@link isolate} holds,
 * PATH names the stand-in directory alone and the environment carries only
 * what a spawn needs, so no test can start a real gh, git or mise, even by
 * falling back to PATH, and no real credential reaches a record. A stand-in
 * starts Bun with `--no-env-file`, so no `.env` file in its working directory
 * reaches its record either.
 */

import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** One start of a stand-in. */
export interface Call {
  /** The name the stand-in records itself under. */
  readonly name: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

/** How a stand-in answers a start. */
export interface Answer {
  readonly stdout?: string;
  readonly exitCode?: number;
  readonly sleepMs?: number;
}

/** Whether launchers are cmd.exe scripts rather than shell scripts. */
export const WINDOWS = process.platform === 'win32';

// Every launcher starts this. It appends the call to calls.jsonl and answers
// from <name>.json, keyed by the arguments joined with spaces, or `*`. It
// moves to the temporary directory first: on Windows a kill that reaches the
// launcher's cmd.exe alone leaves this process running past its case, and a
// process holding a directory keeps it from being removed.
const RECORDER = `import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [dir = '', name = '', ...args] = process.argv.slice(2);
process.chdir(tmpdir());
appendFileSync(join(dir, 'calls.jsonl'), JSON.stringify({ name, args, env: { ...process.env } }) + '\\n');
const control = join(dir, name + '.json');
const answers = existsSync(control) ? JSON.parse(readFileSync(control, 'utf8')) : {};
const answer = answers[args.join(' ')] ?? answers['*'] ?? {};
if (answer.sleepMs) await Bun.sleep(answer.sleepMs);
if (answer.stdout) await Bun.write(Bun.stdout, answer.stdout);
process.exit(answer.exitCode ?? 0);
`;

/** The file a launcher sits in on this platform, for a program named `name`. */
export function launcherName(name: string): string {
  return WINDOWS ? `${name}.cmd` : name;
}

/** A directory of stand-in programs, outside any test's working directory. */
export class StandIns {
  /** The directory holding the launchers and the record. */
  readonly dir: string;

  constructor(names: readonly string[]) {
    this.dir = mkdtempSync(join(tmpdir(), 'gate-stand-ins-'));
    writeFileSync(join(this.dir, 'recorder.ts'), RECORDER);
    writeFileSync(join(this.dir, 'calls.jsonl'), '');
    for (const name of names) {
      this.plant(this.path(name), name);
    }
  }

  /** The launcher path for `name` in {@link dir}. */
  path(name: string): string {
    return join(this.dir, launcherName(name));
  }

  /**
   * Writes a launcher at `path` that records its starts under `name`, so a
   * file planted where no program belongs shows up in {@link calls} when it
   * runs.
   */
  plant(path: string, name: string): void {
    const recorder = join(this.dir, 'recorder.ts');
    if (WINDOWS) {
      writeFileSync(path, `@"${process.execPath}" --no-env-file "${recorder}" "${this.dir}" ${name} %*\r\n`);
    } else {
      writeFileSync(
        path,
        `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${recorder}" "${this.dir}" ${name} "$@"\n`,
      );
      chmodSync(path, 0o755);
    }
  }

  /** Sets how `name` answers a start with `args`, or any start when `args` is `*`. */
  answer(name: string, answer: Answer, args = '*'): void {
    const control = join(this.dir, `${name}.json`);
    let answers: Record<string, Answer> = {};
    try {
      answers = JSON.parse(readFileSync(control, 'utf8')) as Record<string, Answer>;
    } catch {
      // No answer file yet: this is the first answer for the name.
    }
    answers[args] = answer;
    writeFileSync(control, JSON.stringify(answers));
  }

  /** Every start recorded since the last {@link clear}, in order. */
  calls(): Call[] {
    return readFileSync(join(this.dir, 'calls.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Call);
  }

  /** Forgets the recorded starts and every answer. */
  clear(): void {
    writeFileSync(join(this.dir, 'calls.jsonl'), '');
    for (const file of readdirSync(this.dir)) {
      if (file.endsWith('.json')) {
        rmSync(join(this.dir, file), { force: true });
      }
    }
  }

  /** Removes the directory. */
  remove(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** The names a spawn needs and nothing a test could leak or reach through. */
const KEPT: readonly string[] = WINDOWS ? ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PATHEXT'] : ['TMPDIR'];

/**
 * Replaces the process environment with {@link KEPT} and a PATH naming
 * `standIns` alone, and returns a function that puts the original back.
 */
export function isolate(standIns: StandIns): () => void {
  const original: Record<string, string | undefined> = { ...process.env };
  for (const name of Object.keys(process.env)) {
    if (!KEPT.includes(name.toUpperCase())) {
      Reflect.deleteProperty(process.env, name);
    }
  }
  process.env['PATH'] = standIns.dir;
  return () => {
    for (const name of Object.keys(process.env)) {
      Reflect.deleteProperty(process.env, name);
    }
    for (const [name, value] of Object.entries(original)) {
      if (value !== undefined) {
        process.env[name] = value;
      }
    }
  };
}

/** The names in `env` that read as `name` on Windows, whatever their case. */
export function spellings(env: Readonly<Record<string, string | undefined>>, name: string): string[] {
  return Object.keys(env).filter((key) => key.toUpperCase() === name.toUpperCase());
}
