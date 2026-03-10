import * as assert from 'node:assert';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReviewCommentController } from './comments';
import { ReviewHandler } from './review-handler';

suite('ReviewHandler', () => {
  let projectDir: string;
  let handler: ReviewHandler;
  let commentController: ReviewCommentController;

  setup(async () => {
    projectDir = join(tmpdir(), `claude-review-test-${Date.now()}`);
    await mkdir(projectDir, { recursive: true });
    // ReviewCommentController needs an ExtensionContext — cast a minimal stub
    const fakeContext = { subscriptions: [] } as unknown as import('vscode').ExtensionContext;
    commentController = new ReviewCommentController(fakeContext);
    handler = new ReviewHandler(projectDir, commentController);
  });

  teardown(async () => {
    handler.stop();
    commentController.dispose();
    await rm(projectDir, { recursive: true, force: true });
  });

  test('start creates pending and response directories', async () => {
    await handler.start();
    const { stat } = await import('node:fs/promises');
    const pending = await stat(join(projectDir, '.claude-review', 'pending'));
    const responses = await stat(join(projectDir, '.claude-review', 'responses'));
    assert.ok(pending.isDirectory());
    assert.ok(responses.isDirectory());
  });

  test('getHookSettings returns PreToolUse config', () => {
    const settings = handler.getHookSettings() as Record<string, unknown>;
    const hooks = settings.hooks as Record<string, unknown>;
    assert.ok(hooks.PreToolUse, 'Should have PreToolUse key');

    const postHooks = hooks.PreToolUse as Array<{ matcher: string; hooks: unknown[] }>;
    assert.strictEqual(postHooks.length, 1);
    assert.strictEqual(postHooks[0].matcher, 'Edit|Write');
  });

  test('writeContainerSettings creates .claude/settings.json', async () => {
    await handler.writeContainerSettings();
    const settingsPath = join(projectDir, '.claude', 'settings.json');
    const raw = await readFile(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    assert.ok(settings.hooks.PreToolUse);
  });

  test('writeContainerSettings preserves existing settings', async () => {
    const settingsDir = join(projectDir, '.claude');
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      join(settingsDir, 'settings.json'),
      JSON.stringify({ existingKey: 'preserved' }),
    );

    await handler.writeContainerSettings();
    const raw = await readFile(join(settingsDir, 'settings.json'), 'utf-8');
    const settings = JSON.parse(raw);
    assert.strictEqual(settings.existingKey, 'preserved');
    assert.ok(settings.hooks.PreToolUse);
  });

  test('writeHookConfig copies hook script to .claude-review/hooks/', async () => {
    // Create a hooks dir with a source script in projectDir (fallback path)
    const srcHookDir = join(projectDir, 'hooks');
    await mkdir(srcHookDir, { recursive: true });
    await writeFile(join(srcHookDir, 'review-hook.sh'), '#!/bin/bash\necho test');

    await handler.writeHookConfig();
    const dest = join(projectDir, '.claude-review', 'hooks', 'review-hook.sh');
    const content = await readFile(dest, 'utf-8');
    assert.ok(content.includes('#!/bin/bash'));
  });

  test('cleanup removes pending and response files', async () => {
    await handler.start();
    const pendingDir = join(projectDir, '.claude-review', 'pending');
    const responseDir = join(projectDir, '.claude-review', 'responses');
    await writeFile(join(pendingDir, 'test-1.json'), '{}');
    await writeFile(join(responseDir, 'test-1.json'), '{}');

    await handler.cleanup();

    const { readdir } = await import('node:fs/promises');
    const pending = await readdir(pendingDir);
    const responses = await readdir(responseDir);
    assert.strictEqual(pending.length, 0);
    assert.strictEqual(responses.length, 0);
  });
});
