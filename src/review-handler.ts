import { access, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { ReviewCommentController } from './comments';
import { matchGlob } from './glob';

/** Proposal written by the PreToolUse hook — includes full tool_input. */
interface ReviewProposal {
  tool_use_id: string;
  tool_name: string;
  tool_input: {
    file_path: string;
    old_string?: string;
    new_string?: string;
    content?: string;
  };
}

/** Response the extension writes back to the hook. */
interface ReviewResponse {
  action: 'approve' | 'deny';
  feedback?: string;
}

/** Tracks the currently active review. */
interface ActiveReview {
  proposal: ReviewProposal;
  relPath: string;
  afterUri: vscode.Uri;
}

/**
 * Watches `.claude-review/pending/` for proposals from the PreToolUse hook.
 * Opens a non-blocking diff view with approve/deny buttons in the editor title bar.
 */
export class ReviewHandler {
  private watcher: vscode.FileSystemWatcher | undefined;
  private readonly pendingDir: string;
  private readonly responseDir: string;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly beforeEmitter = new vscode.EventEmitter<vscode.Uri>();
  private readonly afterEmitter = new vscode.EventEmitter<vscode.Uri>();
  private beforeContent = '';
  private afterContent = '';
  private beforeProvider: vscode.Disposable | undefined;
  private afterProvider: vscode.Disposable | undefined;
  private activeReview: ActiveReview | undefined;
  private readonly pendingQueue: ReviewProposal[] = [];
  private timeoutCheckInterval: ReturnType<typeof setInterval> | undefined;
  private readonly _onDidChangeReview = new vscode.EventEmitter<ActiveReview | undefined>();
  readonly onDidChangeReview = this._onDidChangeReview.event;

  constructor(
    private readonly projectDir: string,
    private readonly commentController: ReviewCommentController,
  ) {
    const reviewDir = join(projectDir, '.claude-review');
    this.pendingDir = join(reviewDir, 'pending');
    this.responseDir = join(reviewDir, 'responses');
  }

  get hasActiveReview(): boolean {
    return this.activeReview !== undefined;
  }

  async start(): Promise<void> {
    await mkdir(this.pendingDir, { recursive: true });
    await mkdir(this.responseDir, { recursive: true });

    this.beforeProvider = vscode.workspace.registerTextDocumentContentProvider(
      'claude-review-before',
      {
        onDidChange: this.beforeEmitter.event,
        provideTextDocumentContent: () => this.beforeContent,
      },
    );
    this.afterProvider = vscode.workspace.registerTextDocumentContentProvider(
      'claude-review-after',
      {
        onDidChange: this.afterEmitter.event,
        provideTextDocumentContent: () => this.afterContent,
      },
    );

    const pattern = new vscode.RelativePattern(this.pendingDir, '*.json');
    this.watcher = vscode.workspace.createFileSystemWatcher(pattern, false, true, true);
    this.watcher.onDidCreate((uri) => this.onProposalCreated(uri), undefined, this.disposables);
    this.disposables.push(this.watcher);
  }

  stop(): void {
    this.beforeProvider?.dispose();
    this.afterProvider?.dispose();
    this.beforeEmitter.dispose();
    this.afterEmitter.dispose();
    this.activeReview = undefined;
    this.pendingQueue.length = 0;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.watcher = undefined;
  }

  private async onProposalCreated(uri: vscode.Uri): Promise<void> {
    let proposal: ReviewProposal;
    try {
      const raw = await readFile(uri.fsPath, 'utf-8');
      proposal = JSON.parse(raw);
    } catch {
      return;
    }

    // Auto-approve if file matches configured patterns
    if (this.shouldAutoApprove(proposal.tool_input.file_path)) {
      await this.writeResponse(proposal.tool_use_id, { action: 'approve' });
      return;
    }

    // Queue the proposal if another review is already active
    if (this.activeReview) {
      this.pendingQueue.push(proposal);
      return;
    }

    try {
      await this.showReview(proposal);
    } catch (err) {
      await this.writeResponse(proposal.tool_use_id, {
        action: 'deny',
        feedback: `Extension error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private shouldAutoApprove(filePath: string): boolean {
    const patterns = vscode.workspace
      .getConfiguration('baleen')
      .get<string[]>('autoApprovePatterns', []);
    if (patterns.length === 0) return false;

    let relPath = filePath.startsWith('/sandbox/') ? filePath.slice('/sandbox/'.length) : filePath;
    // Also strip leading slash from the path
    relPath = relPath.replace(/^\/+/, '');

    return patterns.some((raw) => {
      // Normalize: strip leading slashes and trailing slashes from pattern
      const pattern = raw.replace(/^\/+/, '').replace(/\/+$/, '');
      // Match as-is (e.g. "*.md", "docs/**")
      if (matchGlob(pattern, relPath)) return true;
      // Also match as a directory prefix (e.g. "local_docs" → "local_docs/**")
      if (matchGlob(`${pattern}/**`, relPath)) return true;
      return false;
    });
  }

  private async showReview(proposal: ReviewProposal): Promise<void> {
    const { tool_name, tool_input, tool_use_id } = proposal;
    const filePath = tool_input.file_path;

    const relPath = filePath.startsWith('/sandbox/')
      ? filePath.slice('/sandbox/'.length)
      : filePath;
    const absPath = join(this.projectDir, relPath);

    let beforeContent: string;
    let afterContent: string;

    if (tool_name === 'Write') {
      try {
        beforeContent = await readFile(absPath, 'utf-8');
      } catch {
        beforeContent = '';
      }
      afterContent = tool_input.content ?? '';
    } else {
      try {
        beforeContent = await readFile(absPath, 'utf-8');
      } catch {
        beforeContent = '';
      }
      const oldStr = tool_input.old_string ?? '';
      const newStr = tool_input.new_string ?? '';
      if (oldStr && beforeContent.includes(oldStr)) {
        afterContent = beforeContent.replace(oldStr, newStr);
      } else {
        afterContent = beforeContent;
      }
    }

    const beforeUri = vscode.Uri.parse(`claude-review-before:${relPath}?id=${tool_use_id}`);
    const afterUri = vscode.Uri.parse(`claude-review-after:${relPath}?id=${tool_use_id}`);

    this.beforeContent = beforeContent;
    this.afterContent = afterContent;
    this.beforeEmitter.fire(beforeUri);
    this.afterEmitter.fire(afterUri);

    this.activeReview = { proposal, relPath, afterUri };
    this._onDidChangeReview.fire(this.activeReview);

    const title = `Review: ${relPath} (${tool_name})`;
    await vscode.commands.executeCommand('vscode.diff', beforeUri, afterUri, title);
  }

  /** Called by the Approve command. */
  async approve(): Promise<void> {
    if (!this.activeReview) return;
    const { proposal } = this.activeReview;
    await this.clearReview();
    await this.writeResponse(proposal.tool_use_id, { action: 'approve' });
  }

  /** Called by the Revert command. Collects inline comments as feedback. */
  async deny(): Promise<void> {
    if (!this.activeReview) return;
    const { proposal, relPath, afterUri } = this.activeReview;

    // Collect inline comments from the diff view as feedback
    const comments = this.commentController.collectFeedbackForUri(afterUri);
    const feedback = this.compileFeedback(relPath, comments);

    await this.clearReview();
    await this.writeResponse(proposal.tool_use_id, {
      action: 'deny',
      feedback: feedback || 'Change denied by reviewer.',
    });
  }

  private async clearReview(): Promise<void> {
    this.activeReview = undefined;
    this._onDidChangeReview.fire(undefined);
    // Close the diff editor tab
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    // Process next queued proposal, if any
    const next = this.pendingQueue.shift();
    if (next) {
      try {
        await this.showReview(next);
      } catch (err) {
        await this.writeResponse(next.tool_use_id, {
          action: 'deny',
          feedback: `Extension error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }
  }

  /** Compile inline comments into structured markdown for Claude. */
  private compileFeedback(
    relPath: string,
    comments: Array<{ line: number; text: string }>,
  ): string {
    if (comments.length === 0) return '';

    const lines = [
      'The user has reviewed your proposed changes and has feedback:',
      '',
      `## /sandbox/${relPath}`,
      '',
    ];
    for (const c of comments) {
      lines.push(`### Line ${c.line}`);
      lines.push(c.text);
      lines.push('');
    }
    lines.push('Please address these comments.');
    return lines.join('\n');
  }

  private async writeResponse(toolUseId: string, response: ReviewResponse): Promise<void> {
    const responsePath = join(this.responseDir, `${toolUseId}.json`);
    await writeFile(responsePath, JSON.stringify(response), 'utf-8');
  }

  async writeHookConfig(): Promise<void> {
    const hookDir = join(this.projectDir, '.claude-review', 'hooks');
    await mkdir(hookDir, { recursive: true });

    const extensionHookSrc = join(__dirname, '..', 'hooks', 'review-hook.sh');
    let hookContent: string;
    try {
      hookContent = await readFile(extensionHookSrc, 'utf-8');
    } catch {
      const workspaceHook = join(this.projectDir, 'hooks', 'review-hook.sh');
      hookContent = await readFile(workspaceHook, 'utf-8');
    }
    const destHookPath = join(hookDir, 'review-hook.sh');
    await writeFile(destHookPath, hookContent, { mode: 0o755 });
  }

  getHookSettings(): object {
    return {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write',
            hooks: [
              {
                type: 'command',
                command: '/sandbox/.claude-review/hooks/review-hook.sh',
              },
            ],
          },
        ],
      },
    };
  }

  async writeContainerSettings(): Promise<void> {
    const settingsDir = join(this.projectDir, '.claude');
    await mkdir(settingsDir, { recursive: true });
    const settingsPath = join(settingsDir, 'settings.json');

    let existing: Record<string, unknown> = {};
    try {
      const raw = await readFile(settingsPath, 'utf-8');
      existing = JSON.parse(raw);
    } catch {
      // No existing settings
    }

    const existingHooks = (existing.hooks ?? {}) as Record<string, unknown>;
    const newHooks = (this.getHookSettings() as { hooks: Record<string, unknown> }).hooks;
    const merged = { ...existing, hooks: { ...existingHooks, ...newHooks } };
    await writeFile(settingsPath, JSON.stringify(merged, null, 2), 'utf-8');
  }

  async cleanup(): Promise<void> {
    for (const dir of [this.pendingDir, this.responseDir]) {
      try {
        const files = await readdir(dir);
        for (const f of files) {
          await unlink(join(dir, f)).catch(() => {});
        }
      } catch {
        // Dir may not exist
      }
    }
  }
}
