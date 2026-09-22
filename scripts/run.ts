/**
 * One finished process: what it printed and how it ended.
 */
export interface Finished {
  /** The exit code, or -1 when the process was killed at the timeout. */
  readonly exitCode: number;
  /** Standard output, decoded as UTF-8. */
  readonly stdout: string;
  /** Standard error, decoded as UTF-8. */
  readonly stderr: string;
  /** True when the process ran past `timeoutMs` and was killed. */
  readonly timedOut: boolean;
}

/**
 * Runs one command to completion with its output captured.
 *
 * @remarks
 * Every process the gate starts goes through here, so every one carries a
 * deadline. A tool that hangs is a red row, not a hung gate.
 *
 * A program that is not on PATH is a failed process too, exit 127 with the
 * spawn error as its stderr, so a missing prerequisite reads like any other
 * red row rather than a crash of the gate.
 *
 * @param cmd - The program and its arguments, the program first
 * @param timeoutMs - The deadline, after which the process is killed
 * @param env - Variables added to the gate's own environment for this process
 * @param show - When true the process writes to the gate's own stdout and
 * stderr, so a report it prints reaches the log, and the captured streams are
 * empty
 * @returns What the process printed and how it ended
 */
export function run(
  cmd: readonly string[],
  timeoutMs: number,
  env: Readonly<Record<string, string>> = {},
  show = false,
): Finished {
  let finished: ReturnType<typeof Bun.spawnSync>;
  try {
    finished = Bun.spawnSync({
      cmd: [...cmd],
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdout: show ? 'inherit' : 'pipe',
      stderr: show ? 'inherit' : 'pipe',
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return { exitCode: 127, stdout: '', stderr: `${cmd[0] ?? ''}: ${message}`, timedOut: false };
  }
  const timedOut: boolean = finished.exitedDueToTimeout === true;
  return {
    exitCode: timedOut ? -1 : finished.exitCode,
    stdout: finished.stdout?.toString() ?? '',
    stderr: finished.stderr?.toString() ?? '',
    timedOut,
  };
}

/**
 * The text a failed process leaves for the row's message: its exit and both
 * streams, trimmed, or a note that it printed nothing.
 */
export function describe(finished: Finished): string {
  const printed: string = [finished.stdout, finished.stderr].join('\n').trim();
  const ending: string = finished.timedOut ? 'was killed at its deadline' : `exited ${String(finished.exitCode)}`;
  return `${ending} saying: ${printed.length === 0 ? 'nothing' : printed}`;
}
