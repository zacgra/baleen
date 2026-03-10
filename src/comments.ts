import * as vscode from 'vscode';

/**
 * Manages inline review comments on diff views.
 * Uses the VS Code CommentController API to let users annotate
 * specific lines of Claude's edits.
 */
export class ReviewCommentController {
  private controller: vscode.CommentController;
  private threads: vscode.CommentThread[] = [];

  constructor(context: vscode.ExtensionContext) {
    this.controller = vscode.comments.createCommentController('baleen', 'Baleen');
    this.controller.commentingRangeProvider = {
      provideCommentingRanges: (document: vscode.TextDocument) => {
        // Allow commenting on any line in our review schemes
        const scheme = document.uri.scheme;
        if (scheme === 'claude-review-before' || scheme === 'claude-review-after') {
          return [new vscode.Range(0, 0, document.lineCount - 1, 0)];
        }
        return [];
      },
    };
    this.controller.options = { prompt: 'Add review comment...' };

    context.subscriptions.push(this.controller);

    context.subscriptions.push(
      vscode.commands.registerCommand('baleen.addComment', (reply: vscode.CommentReply) =>
        this.addComment(reply),
      ),
    );
  }

  private addComment(reply: vscode.CommentReply) {
    const comment: vscode.Comment = {
      body: reply.text,
      mode: vscode.CommentMode.Preview,
      author: { name: 'You' },
    };

    reply.thread.comments = [...reply.thread.comments, comment];
    this.threads.push(reply.thread);
  }

  /**
   * Collect comments for a specific URI (e.g. the "after" side of a diff review).
   * Returns comments sorted by line number, then clears those threads.
   */
  collectFeedbackForUri(uri: vscode.Uri): Array<{ line: number; text: string }> {
    const feedback: Array<{ line: number; text: string }> = [];
    const remaining: vscode.CommentThread[] = [];

    for (const thread of this.threads) {
      if (thread.uri.toString() === uri.toString()) {
        const line = (thread.range?.start.line ?? 0) + 1;
        for (const comment of thread.comments) {
          const text = typeof comment.body === 'string' ? comment.body : comment.body.value;
          feedback.push({ line, text });
        }
        thread.dispose();
      } else {
        remaining.push(thread);
      }
    }

    this.threads = remaining;
    feedback.sort((a, b) => a.line - b.line);
    return feedback;
  }

  dispose() {
    this.controller.dispose();
  }
}
