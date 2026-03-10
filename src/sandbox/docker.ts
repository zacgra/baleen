import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { SandboxOptions } from './provider';

const execFileAsync = promisify(execFile);

function getConfiguredImage(): string {
  return vscode.workspace.getConfiguration('baleen').get<string>('dockerImage', 'baleen-sandbox');
}

export class DockerProvider {
  async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('docker', ['info']);
      return true;
    } catch {
      return false;
    }
  }

  async killContainer(containerName: string): Promise<void> {
    try {
      await execFileAsync('docker', ['rm', '-f', containerName]);
    } catch {
      // Container may already be gone
    }
  }
}

export function buildRunArgs(
  containerName: string,
  options: SandboxOptions,
  image?: string,
): string[] {
  const args = [
    'run',
    '--name',
    containerName,
    '--rm',
    '-it',

    // Mount project directory read-write
    '-v',
    `${options.projectDir}:/sandbox`,
    '-w',
    '/sandbox',

    // Shadow home — empty tmpfs so no host credentials leak.
    // uid/gid 1000 matches the baleen user created in the Dockerfile.
    '--tmpfs',
    '/home/baleen:exec,uid=1000,gid=1000',

    // Persist Claude Code credentials across container restarts
    '-v',
    'baleen-auth:/home/baleen/.claude',

    // No privilege escalation
    '--security-opt=no-new-privileges',
  ];

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      args.push('-e', `${key}=${value}`);
    }
  }

  args.push(image ?? getConfiguredImage());

  return args;
}

/**
 * Build the sandbox Docker image if it doesn't exist.
 * Runs `docker build` in a VS Code terminal so the user can see progress.
 */
export async function ensureImage(image?: string, extensionRoot?: string): Promise<void> {
  image = image ?? getConfiguredImage();
  try {
    await execFileAsync('docker', ['image', 'inspect', image]);
  } catch {
    const contextDir = extensionRoot ?? process.cwd();
    const dockerfilePath = join(contextDir, 'Dockerfile');

    const logPath = join(tmpdir(), 'baleen-build.log');
    const logStream = createWriteStream(logPath);

    const writeEmitter = new vscode.EventEmitter<string>();
    const closeEmitter = new vscode.EventEmitter<number>();

    const child = spawn(
      'docker',
      ['build', '--progress=plain', '-t', image, '-f', dockerfilePath, contextDir],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    for (const stream of [child.stdout, child.stderr]) {
      stream?.on('data', (data: Buffer) => {
        logStream.write(data);
        writeEmitter.fire(data.toString().replace(/\n/g, '\r\n'));
      });
    }

    const terminal = vscode.window.createTerminal({
      name: 'Sandbox Build',
      pty: {
        onDidWrite: writeEmitter.event,
        onDidClose: closeEmitter.event,
        open() {},
        close() {
          child.kill();
        },
        handleInput() {},
      },
    });
    terminal.show();

    const exitCode = await new Promise<number>((resolve) => {
      child.on('close', (code) => {
        logStream.end();
        const c = code ?? 1;
        if (c !== 0) {
          writeEmitter.fire(`\r\n\x1b[31mBuild failed with exit code ${c}.\x1b[0m\r\n`);
          writeEmitter.fire(`\r\nFull log: ${logPath}\r\n`);
        }
        closeEmitter.fire(c);
        resolve(c);
      });
    });

    if (exitCode !== 0) {
      throw new Error(`Docker build failed (log: ${logPath})`);
    }
    terminal.dispose();
  }
}
