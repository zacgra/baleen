import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run a git command in the given working directory.
 */
export async function execGit(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, { cwd });
    return { stdout, stderr, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      exitCode: e.code ?? 1,
    };
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  const result = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd);
  if (result.exitCode !== 0) throw new Error(`Failed to get current branch: ${result.stderr}`);
  return result.stdout.trim();
}

export async function addWorktree(
  repoDir: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  const result = await execGit(['worktree', 'add', '-b', branch, worktreePath], repoDir);
  if (result.exitCode !== 0) throw new Error(`git worktree add failed: ${result.stderr}`);
}

export async function removeWorktree(repoDir: string, worktreePath: string): Promise<void> {
  await execGit(['worktree', 'remove', '--force', worktreePath], repoDir);
}

export async function deleteBranch(repoDir: string, branch: string): Promise<void> {
  await execGit(['branch', '-D', branch], repoDir);
}

export async function getFileAtHead(relativePath: string, cwd: string): Promise<string | null> {
  const result = await execGit(['show', `HEAD:${relativePath}`], cwd);
  if (result.exitCode !== 0) return null;
  return result.stdout;
}

/**
 * Content provider for git HEAD file versions.
 * Registers a `git-head:` URI scheme that resolves file contents from HEAD.
 */
export class GitHeadContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const relativePath = uri.path;
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) return '';

    const cwd = workspaceFolders[0].uri.fsPath;
    const content = await getFileAtHead(relativePath, cwd);
    return content ?? '';
  }
}
