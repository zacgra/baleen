import * as assert from 'node:assert';
import { buildRunArgs } from './sandbox/docker';

suite('buildRunArgs', () => {
  test('produces correct base args', () => {
    const args = buildRunArgs('test-container', { projectDir: '/home/user/project' });

    assert.ok(args.includes('run'));
    assert.ok(args.includes('--rm'));
    assert.ok(args.includes('-it'));
    assert.ok(args.includes('--name'));
    assert.ok(args.includes('test-container'));
  });

  test('mounts project directory at /sandbox', () => {
    const args = buildRunArgs('test', { projectDir: '/home/user/project' });
    const vIdx = args.indexOf('/home/user/project:/sandbox');
    assert.ok(vIdx > 0);
    assert.strictEqual(args[vIdx - 1], '-v');
  });

  test('sets working directory to /sandbox', () => {
    const args = buildRunArgs('test', { projectDir: '/tmp/proj' });
    const wIdx = args.indexOf('/sandbox');
    assert.ok(wIdx > 0);
    assert.strictEqual(args[wIdx - 1], '-w');
  });

  test('configures tmpfs with correct uid/gid', () => {
    const args = buildRunArgs('test', { projectDir: '/tmp/proj' });
    const tmpfs = args.find((a) => a.includes('uid=1000'));
    assert.ok(tmpfs, 'Should have tmpfs with uid=1000');
    assert.ok(tmpfs?.includes('gid=1000'));
    assert.ok(tmpfs?.includes('exec'));
  });

  test('includes security opt', () => {
    const args = buildRunArgs('test', { projectDir: '/tmp/proj' });
    assert.ok(args.includes('--security-opt=no-new-privileges'));
  });

  test('passes env vars', () => {
    const args = buildRunArgs('test', {
      projectDir: '/tmp/proj',
      env: { FOO: 'bar', BAZ: 'qux' },
    });
    const eIndices: number[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-e') eIndices.push(i);
    }
    assert.strictEqual(eIndices.length, 2);
    assert.strictEqual(args[eIndices[0] + 1], 'FOO=bar');
    assert.strictEqual(args[eIndices[1] + 1], 'BAZ=qux');
  });

  test('ends with image name', () => {
    const args = buildRunArgs('test', { projectDir: '/tmp/proj' });
    assert.strictEqual(args[args.length - 1], 'baleen-sandbox');
  });
});
