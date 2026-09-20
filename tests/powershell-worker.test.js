const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { PowerShellWorker, WORKER_SCRIPT } = require('../powershell-worker');

class FakeChild extends EventEmitter {
  constructor(onRequest, ready = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.stdin = new Writable({
      write: (chunk, _encoding, callback) => {
        const request = JSON.parse(chunk.toString().trim());
        onRequest(request, this);
        callback();
      }
    });
    queueMicrotask(() => {
      this.emit('spawn');
      this.send({
        type: 'ready', workerPid: 1234, initializationMs: 280,
        stages: { nativeCompileMs: 140, comCreateMs: 45 }, ...ready
      });
    });
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  kill() {
    if (this.killed) return;
    this.killed = true;
    queueMicrotask(() => this.emit('exit', 1, null));
  }
}

test('initializes once and reuses one worker for multiple requests', async () => {
  const events = [];
  const requests = [];
  let spawnCount = 0;
  const worker = new PowerShellWorker({
    startupTimeoutMs: 100,
    requestTimeoutMs: 100,
    log: (event, details) => events.push({ event, details }),
    getOperationId: () => 'operation-1',
    spawnProcess(command, args) {
      spawnCount++;
      assert.equal(command, 'powershell.exe');
      assert.ok(args.includes('-STA'));
      return new FakeChild((request, child) => {
        requests.push(request);
        child.send({
          type: 'response', id: request.id, ok: true,
          result: { IconLocation: request.iconLocation || '' },
          workerDurationMs: 8, stages: { shortcutSaveMs: 5 }
        });
      });
    }
  });

  await worker.start();
  const first = await worker.request('write', { shortcutPath: 'first.lnk', iconLocation: 'first.ico,0' });
  const second = await worker.request('writeAndRefresh', { shortcutPath: 'second.lnk', iconLocation: 'second.ico,0' });

  assert.equal(spawnCount, 1);
  assert.equal(requests.length, 2);
  assert.equal(first.IconLocation, 'first.ico,0');
  assert.equal(second.IconLocation, 'second.ico,0');
  const completions = events.filter(item => item.event === 'powershell.worker.complete');
  assert.equal(completions.length, 2);
  assert.equal(completions[0].details.operationId, 'operation-1');
  worker.stop();
});

test('restarts once when the worker exits during a request', async () => {
  let spawnCount = 0;
  const worker = new PowerShellWorker({
    startupTimeoutMs: 100,
    requestTimeoutMs: 100,
    spawnProcess() {
      spawnCount++;
      const generation = spawnCount;
      return new FakeChild((request, child) => {
        if (generation === 1) {
          queueMicrotask(() => child.emit('exit', 9, null));
          return;
        }
        child.send({ type: 'response', id: request.id, ok: true, result: { TargetPath: 'ok.exe' }, workerDurationMs: 1 });
      });
    }
  });

  const result = await worker.request('read', { shortcutPath: 'target.lnk' });
  assert.equal(result.TargetPath, 'ok.exe');
  assert.equal(spawnCount, 2);
  worker.stop();
});

test('does not retry a command rejected by the worker', async () => {
  let spawnCount = 0;
  let requestCount = 0;
  const worker = new PowerShellWorker({
    startupTimeoutMs: 100,
    requestTimeoutMs: 100,
    spawnProcess() {
      spawnCount++;
      return new FakeChild((request, child) => {
        requestCount++;
        child.send({ type: 'response', id: request.id, ok: false, error: 'invalid shortcut', workerDurationMs: 1 });
      });
    }
  });

  await assert.rejects(worker.request('write', { shortcutPath: 'bad.lnk' }), /invalid shortcut/);
  assert.equal(spawnCount, 1);
  assert.equal(requestCount, 1);
  worker.stop();
});

test('worker source initializes native code and COM before reading requests', () => {
  const readyIndex = WORKER_SCRIPT.indexOf("type = 'ready'");
  assert.ok(WORKER_SCRIPT.indexOf('Add-Type') < readyIndex);
  assert.match(WORKER_SCRIPT, /DllImport\("shell32\.dll"\)/);
  assert.ok(WORKER_SCRIPT.indexOf('New-Object -ComObject WScript.Shell') < readyIndex);
  assert.ok(WORKER_SCRIPT.indexOf('[Console]::In.ReadLine()') > readyIndex);
});

test('worker uses a single flushing shell notification and logs refresh details', () => {
  assert.match(WORKER_SCRIPT, /\$targetNotifyFlags = if \(\$RefreshAll\).*0x0005.*0x1005/);
  assert.match(WORKER_SCRIPT, /SHChangeNotify\(0x00002000, \$targetNotifyFlags/);
  assert.match(WORKER_SCRIPT, /SHChangeNotify\(0x08000000, 0x1000/);
  assert.match(WORKER_SCRIPT, /\$Stages\.refreshMode/);
  assert.match(WORKER_SCRIPT, /\$Stages\.targetNotifications/);
  assert.match(WORKER_SCRIPT, /\$Stages\.targetNotifyMs/);
  assert.doesNotMatch(WORKER_SCRIPT, /Start-Sleep/);
});

test('embedded worker is valid PowerShell syntax', { skip: process.platform !== 'win32' }, () => {
  const parserScript = String.raw`
    $source = [Console]::In.ReadToEnd()
    $tokens = $null
    $parseErrors = $null
    [void][System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count -gt 0) {
      [Console]::Error.WriteLine(($parseErrors | ForEach-Object { $_.Message }) -join [Environment]::NewLine)
      exit 1
    }
  `;
  const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', parserScript], {
    input: WORKER_SCRIPT,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
