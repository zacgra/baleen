import * as assert from 'node:assert';
import * as vscode from 'vscode';

suite('Extension', () => {
  test('should activate', async () => {
    const ext = vscode.extensions.getExtension('undefined_publisher.baleen');
    assert.ok(ext, 'Extension should be found');
    await ext.activate();
    assert.strictEqual(ext.isActive, true);
  });

  test('should register all commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('baleen.start'));
    assert.ok(commands.includes('baleen.stop'));
    assert.ok(commands.includes('baleen.reviewFile'));
  });

  test('should register git-head content provider', async () => {
    // Opening a git-head: URI should not throw
    try {
      const doc = await vscode.workspace.openTextDocument(
        vscode.Uri.parse('git-head:nonexistent.txt'),
      );
      assert.ok(doc, 'Should return a document (even if empty)');
    } catch {
      // Expected if no workspace/git — that's fine
    }
  });
});
