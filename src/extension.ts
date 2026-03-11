import * as vscode from 'vscode';
import { ReviewCommentController } from './comments';
import { openDiffForFile } from './diff';
import { GitHeadContentProvider } from './git';
import { SessionManager } from './session';

let commentController: ReviewCommentController | undefined;
let manager: SessionManager | undefined;
let reviewListener: vscode.Disposable | undefined;

export function activate(context: vscode.ExtensionContext) {
  // Register content provider for git HEAD file versions
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('git-head', new GitHeadContentProvider()),
  );

  commentController = new ReviewCommentController(context);
  manager = new SessionManager(context, commentController);

  context.subscriptions.push(
    vscode.commands.registerCommand('baleen.start', async () => {
      // Subscribe once — SessionManager bubbles up events from all session handlers
      if (!reviewListener) {
        reviewListener = manager?.onDidChangeReview((hasReview) => {
          vscode.commands.executeCommand('setContext', 'baleen.hasActiveReview', hasReview);
        });
      }
      await manager?.start();
    }),

    vscode.commands.registerCommand('baleen.stop', async () => {
      await manager?.stop();
      if (!manager?.hasRunningSessions) {
        reviewListener?.dispose();
        reviewListener = undefined;
        vscode.commands.executeCommand('setContext', 'baleen.hasActiveReview', false);
      }
      vscode.window.showInformationMessage('Baleen session stopped.');
    }),

    vscode.commands.registerCommand('baleen.reviewFile', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('No active file to review.');
        return;
      }
      await openDiffForFile(editor.document.uri);
    }),

    vscode.commands.registerCommand('baleen.approve', async () => {
      await manager?.review?.approve();
      vscode.commands.executeCommand('setContext', 'baleen.hasActiveReview', false);
    }),

    vscode.commands.registerCommand('baleen.deny', async () => {
      await manager?.review?.deny();
      vscode.commands.executeCommand('setContext', 'baleen.hasActiveReview', false);
    }),
  );
}

export function deactivate() {
  vscode.commands.executeCommand('setContext', 'baleen.hasActiveReview', false);
  reviewListener?.dispose();
  manager?.stopAll();
  commentController?.dispose();
}
