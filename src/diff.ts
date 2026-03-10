import * as vscode from 'vscode';
import { execGit } from './git';

/**
 * Opens a split diff view comparing the git HEAD version to the working copy.
 */
export async function openDiffForFile(uri: vscode.Uri) {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) return;

  const relativePath = vscode.workspace.asRelativePath(uri);
  const cwd = workspaceFolder.uri.fsPath;

  // Check if file has changes relative to HEAD
  const hasChanges = await execGit(['diff', '--quiet', 'HEAD', '--', relativePath], cwd);
  if (hasChanges.exitCode === 0) return; // No changes

  // Create a URI for the git HEAD version
  const headUri = vscode.Uri.parse(`git-head:${relativePath}`);
  const title = `${relativePath} (HEAD ↔ Working)`;

  await vscode.commands.executeCommand('vscode.diff', headUri, uri, title);
}
