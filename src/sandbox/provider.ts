import type { ChildProcess } from 'node:child_process';

export interface SandboxOptions {
  /** Absolute path to the project directory on the host. */
  projectDir: string;
  /** Additional environment variables to pass through. */
  env?: Record<string, string>;
}

export interface SandboxProcess {
  /** The underlying child process. */
  process: ChildProcess;
  /** Kill the sandboxed process and clean up. */
  kill(): Promise<void>;
}

/**
 * A sandbox provider can spawn Claude Code in an isolated environment.
 */
export interface SandboxProvider {
  /** Human-readable name for this provider. */
  readonly name: string;

  /** Check if this provider is available on the current system. */
  isAvailable(): Promise<boolean>;

  /** Start a sandboxed Claude Code session. */
  spawn(options: SandboxOptions): Promise<SandboxProcess>;
}
