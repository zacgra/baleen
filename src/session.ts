import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewCommentController } from './comments';
import { addWorktree, deleteBranch, removeWorktree } from './git';
import { ReviewHandler } from './review-handler';
import { buildRunArgs, DockerProvider, ensureImage } from './sandbox/docker';

interface BaleenSession {
  terminal: vscode.Terminal;
  containerName: string;
  worktreePath: string;
  branchName: string;
  reviewHandler: ReviewHandler;
}

export class SessionManager {
  private readonly sessions = new Map<string, BaleenSession>();
  private readonly docker = new DockerProvider();
  private sessionCounter = 0;
  private terminalListener: vscode.Disposable | undefined;
  private readonly _onDidChangeReview = new vscode.EventEmitter<boolean>();
  readonly onDidChangeReview = this._onDidChangeReview.event;

  constructor(
    private readonly extensionContext: vscode.ExtensionContext,
    private readonly commentController: ReviewCommentController,
  ) {}

  private get projectDir(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  async start(): Promise<void> {
    const projectDir = this.projectDir;
    if (!projectDir) {
      vscode.window.showErrorMessage('Open a workspace folder first.');
      return;
    }

    const available = await this.docker.isAvailable();
    if (!available) {
      vscode.window.showErrorMessage('Docker is not running. Start Docker Desktop and try again.');
      return;
    }

    await ensureImage(undefined, this.extensionContext.extensionPath);

    this.sessionCounter++;
    const containerName = `baleen-${Date.now()}`;
    const branchName = `baleen/session-${this.sessionCounter}-${Date.now()}`;
    const worktreePath = join(projectDir, '.worktrees', `baleen-${this.sessionCounter}`);

    await addWorktree(projectDir, worktreePath, branchName);

    const reviewHandler = new ReviewHandler(worktreePath, this.commentController);
    reviewHandler.onDidChangeReview((review) => {
      this._onDidChangeReview.fire(!!review);
    });
    await reviewHandler.writeHookConfig();
    await reviewHandler.writeContainerSettings();
    await reviewHandler.start();

    // Listen for terminal closures on first session
    if (!this.terminalListener) {
      this.terminalListener = vscode.window.onDidCloseTerminal((closed) => {
        for (const [name, s] of this.sessions) {
          if (s.terminal === closed) {
            this.teardownSession(s);
            this.sessions.delete(name);
            break;
          }
        }
        if (this.sessions.size === 0) {
          this.terminalListener?.dispose();
          this.terminalListener = undefined;
        }
      });
    }

    const args = buildRunArgs(containerName, { projectDir: worktreePath });
    const cmd = ['docker', ...args].map(shellEscape).join(' ');

    const label = this.sessionCounter === 1 ? 'Baleen' : `Baleen (${this.sessionCounter})`;
    const terminal = vscode.window.createTerminal({ name: label });
    terminal.show();
    terminal.sendText(`clear && ${cmd}`);

    this.sessions.set(containerName, {
      terminal,
      containerName,
      worktreePath,
      branchName,
      reviewHandler,
    });
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
        detail: s.branchName,
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
      await this.teardownSession(target);
    }

    if (this.sessions.size === 0) {
      this.terminalListener?.dispose();
      this.terminalListener = undefined;
    }
  }

  async stopAll(): Promise<void> {
    const teardowns = [...this.sessions.values()].map(async (s) => {
      s.terminal.dispose();
      await this.docker.killContainer(s.containerName);
      await this.teardownSession(s);
    });
    await Promise.all(teardowns);
    this.sessions.clear();
    this.terminalListener?.dispose();
    this.terminalListener = undefined;
  }

  private async teardownSession(session: BaleenSession): Promise<void> {
    session.reviewHandler.stop();
    await session.reviewHandler.cleanup();

    const projectDir = this.projectDir;
    if (projectDir) {
      await removeWorktree(projectDir, session.worktreePath);
      await deleteBranch(projectDir, session.branchName);
    }
  }

  /** Return the ReviewHandler for the currently-active review (if any). */
  get review(): ReviewHandler | undefined {
    for (const s of this.sessions.values()) {
      if (s.reviewHandler.hasActiveReview) return s.reviewHandler;
    }
    return undefined;
  }

  get hasRunningSessions(): boolean {
    return this.sessions.size > 0;
  }

  get sessionCount(): number {
    return this.sessions.size;
  }
}

function shellEscape(arg: string): string {
  if (/^[a-zA-Z0-9_./:=-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, "'\\''")}'`;
}
