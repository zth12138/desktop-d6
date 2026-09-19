const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// In-memory log destination: no Electron process or desktop shortcut operations.
function fixture() {
  const lines = [];
  const warnings = [];
  let writes = 0;
  let fail = false;
  const fakeFs = {
    mkdir(_folder, _options, callback) { queueMicrotask(() => callback(fail ? new Error('read only') : null)); },
    appendFile(file, batch, _encoding, callback) {
      writes++;
      for (const line of batch.trim().split('\n')) lines.push({ file, record: JSON.parse(line) });
      queueMicrotask(() => callback(null));
    }
  };
  const context = {
    module: { exports: {} }, process,
    queueMicrotask,
    console: { error: (...args) => warnings.push(args) },
    require: name => name === 'fs' ? fakeFs : require(name)
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../performance-log.js'), 'utf8'), context);
  const logger = new context.module.exports.PerformanceLog('project/log/desktop-d6.log');
  return { logger, lines, warnings, writes: () => writes, fail: () => { fail = true; } };
}

test('disabled by default; toggle stops appends without clearing earlier records', async () => {
  const f = fixture();
  assert.equal(await f.logger.operation('randomize', () => 7), 7);
  f.logger.write('disabled');
  assert.equal(f.writes(), 0);
  f.logger.enabled = true;
  f.logger.sync('png.read', () => Buffer.from('png'));
  await f.logger.flush();
  assert.equal(f.lines[0].record.event, 'png.read');
  assert.ok(f.lines[0].record.durationMs >= 0);
  f.logger.enabled = false;
  await f.logger.measure('disabled', () => 8);
  assert.equal(f.writes(), 1);
});

test('background completion retains operation ID after request returned; concurrent operations differ', async () => {
  const f = fixture();
  f.logger.enabled = true;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let background;
  await f.logger.operation('randomize', () => {
    background = gate.then(() => f.logger.write('shortcut.queue.complete'));
    return 1;
  });
  await f.logger.operation('restore', () => f.logger.measure('shortcut.restore', () => 2));
  release();
  await background;
  await f.logger.flush();
  const record = name => f.lines.find(line => line.record.event === name).record;
  assert.equal(record('randomize.return').operationId, record('shortcut.queue.complete').operationId);
  assert.notEqual(record('restore.return').operationId, record('randomize.return').operationId);
  assert.ok(record('shortcut.queue.complete').operationElapsedMs >= record('randomize.return').operationElapsedMs);
});

test('sync/async failures log duration and rethrow original exception', async () => {
  const f = fixture();
  f.logger.enabled = true;
  const error = new Error('save failed');
  assert.throws(() => f.logger.sync('ico.write', () => { throw error; }), e => e === error);
  await assert.rejects(f.logger.operation('restore', () => f.logger.measure('shortcut.restore', () => Promise.reject(error))), e => e === error);
  await f.logger.flush();
  const failures = f.lines.filter(line => line.record.status === 'error');
  assert.equal(failures.length, 3);
  for (const { record } of failures) {
    assert.equal(record.message, 'save failed');
    assert.ok(record.durationMs >= 0);
  }
});

test('unwritable logs do not break operations; warning is emitted once', async () => {
  const f = fixture();
  f.logger.enabled = true;
  f.fail();
  assert.equal(await f.logger.operation('randomize', () => 42), 42);
  await f.logger.flush();
  assert.equal(f.warnings.length, 1);
  assert.equal(f.writes(), 0);
});

test('bursts are appended asynchronously in one batch and flush waits for completion', async () => {
  const f = fixture();
  f.logger.enabled = true;
  f.logger.write('one');
  f.logger.write('two');
  assert.equal(f.writes(), 0);
  await f.logger.flush();
  assert.equal(f.writes(), 1);
  assert.deepEqual(f.lines.map(line => line.record.event), ['one', 'two']);
});
