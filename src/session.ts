import * as vscode from 'vscode';
import type { ReviewCommentController } from './comments';
import { ReviewHandler } from './review-handler';
import { buildRunArgs, DockerProvider, ensureImage } from './sandbox/docker';

/** A single container session (terminal + container). */
interface BaleenSession {
  terminal: vscode.Terminal;
  containerName: string;
}

/** Manages multiple concurrent Baleen sessions with a shared ReviewHandler. */
export class SessionManager {
  private readonly sessions = new Map<string, BaleenSession>();
  private readonly docker = new DockerProvider();
  private reviewHandler: ReviewHandler | undefined;
  private sessionCounter = 0;
  private terminalListener: vscode.Disposable | undefined;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly commentController: ReviewCommentController,
  ) {}

  async start(): Promise<void> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const projectDir = workspaceFolders[0].uri.fsPath;

    const available = await this.docker.isAvailable();
    if (!available) {
      vscode.window.showErrorMessage('Docker is not running. Start Docker Desktop and try again.');
      return;
    }

    await ensureImage(undefined, this.extensionContext.extensionPath);

    // Start the shared ReviewHandler on first session
    if (!this.reviewHandler) {
      this.reviewHandler = new ReviewHandler(projectDir, this.commentController);
      await this.reviewHandler.writeHookConfig();
      await this.reviewHandler.writeContainerSettings();
      await this.reviewHandler.start();

      // Listen for terminal closures to clean up sessions
      this.terminalListener = vscode.window.onDidCloseTerminal((closed) => {
        for (const [name, s] of this.sessions) {
          if (s.terminal === closed) {
            this.sessions.delete(name);
            break;
          }
        }
        if (this.sessions.size === 0) {
          this.reviewHandler?.stop();
          this.reviewHandler = undefined;
          this.terminalListener?.dispose();
          this.terminalListener = undefined;
        }
      });
    }

    this.sessionCounter++;
    const containerName = `baleen-${Date.now()}`;

    const args = buildRunArgs(containerName, { projectDir });
    const cmd = ['docker', ...args].map(shellEscape).join(' ');

    const label = this.sessionCounter === 1 ? 'Baleen' : `Baleen (${this.sessionCounter})`;
    const terminal = vscode.window.createTerminal({ name: label });
    terminal.show();
    terminal.sendText(`clear && ${cmd}`);

    const session: BaleenSession = { terminal, containerName };

    this.sessions.set(containerName, session);
  }

  async stop(): Promise<void> {
    if (this.sessions.size === 0) {
      vscode.window.showInformationMessage('No active Baleen sessions.');
      return;
    }

    let target: BaleenSession | undefined;

    if (this.sessions.size === 1) {
      target = this.sessions.values().next().value;
    } else {
      const items = [...this.sessions.entries()].map(([name, s]) => ({
        label: s.terminal.name,
        containerName: name,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a session to stop',
      });
      if (!pick) return;
      target = this.sessions.get(pick.containerName);
    }

    if (target) {
      this.sessions.delete(target.containerName);
      await this.docker.killContainer(target.containerName);
      target.terminal.dispose();
    }

    if (this.sessions.size === 0) {
      this.reviewHandler?.stop();
      await this.reviewHandler?.cleanup();
      this.reviewHandler = undefined;
      this.terminalListener?.dispose();
      this.terminalListener = undefined;
    }
  }

  async stopAll(): Promise<void> {
    const stops = [...this.sessions.values()].map((s) => {
      s.terminal.dispose();
      return this.docker.killContainer(s.containerName);
    });
    await Promise.all(stops);
    this.sessions.clear();
    this.reviewHandler?.stop();
    await this.reviewHandler?.cleanup();
    this.reviewHandler = undefined;
    this.terminalListener?.dispose();
    this.terminalListener = undefined;
  }

  get hasRunningSessions(): boolean {
    return this.sessions.size > 0;
  }

  get review(): ReviewHandler | undefined {
    return this.reviewHandler;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}

function shellEscape(arg: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
