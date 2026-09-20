const { spawn } = require('child_process');

const WORKER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)

function Send-DesktopD6Message($Message) {
  [Console]::Out.WriteLine(($Message | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

function Get-ElapsedMilliseconds($Timer) {
  return [Math]::Round($Timer.Elapsed.TotalMilliseconds, 3)
}

function Get-DesktopD6CacheKey([string]$ShortcutPath) {
  return $ShortcutPath.ToLowerInvariant()
}

function Remove-DesktopD6CachedLink([string]$ShortcutPath) {
  if ([String]::IsNullOrWhiteSpace($ShortcutPath)) { return }
  $key = Get-DesktopD6CacheKey $ShortcutPath
  if (-not $desktopD6LinkCache.ContainsKey($key)) { return }
  try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktopD6LinkCache[$key]) } catch {}
  $desktopD6LinkCache.Remove($key)
}

function Clear-DesktopD6CachedLinks([string]$ExceptPath = '') {
  $exceptKey = if ([String]::IsNullOrWhiteSpace($ExceptPath)) { '' } else { Get-DesktopD6CacheKey $ExceptPath }
  foreach ($key in @($desktopD6LinkCache.Keys)) {
    if ($key -ne $exceptKey) { Remove-DesktopD6CachedLink $key }
  }
}

function Get-DesktopD6WritableLink([string]$ShortcutPath, [bool]$UseCache, $Stages) {
  $key = Get-DesktopD6CacheKey $ShortcutPath
  if ($UseCache) {
    Clear-DesktopD6CachedLinks $ShortcutPath
    if ($desktopD6LinkCache.ContainsKey($key)) {
      $Stages.cacheHit = $true
      $Stages.shortcutOpenMs = 0.0
      return $desktopD6LinkCache[$key]
    }
  }
  else {
    Remove-DesktopD6CachedLink $ShortcutPath
  }
  $Stages.cacheHit = $false
  $openTimer = [Diagnostics.Stopwatch]::StartNew()
  $newLink = $desktopD6Shell.CreateShortcut($ShortcutPath)
  $Stages.shortcutOpenMs = Get-ElapsedMilliseconds $openTimer
  if ($UseCache) { $desktopD6LinkCache[$key] = $newLink }
  return $newLink
}

function Invoke-DesktopD6Refresh($ShortcutPaths, [bool]$RefreshAll, $Stages) {
  $targetNotificationMs = 0.0
  $fullNotificationMs = 0.0
  $memoryMs = 0.0
  $resolvedShortcutPaths = @($ShortcutPaths)
  $targetNotifyFlags = if ($RefreshAll) { [uint32]0x0005 } else { [uint32]0x1005 }
  $Stages.refreshMode = if ($RefreshAll) { 'all-flush' } else { 'target-flush' }
  $Stages.targetNotifyFlags = if ($RefreshAll) { 'SHCNF_PATHW' } else { 'SHCNF_PATHW|SHCNF_FLUSH' }
  $Stages.targetNotifications = $resolvedShortcutPaths.Count
  $Stages.fullNotifyFlags = if ($RefreshAll) { 'SHCNF_FLUSH' } else { '' }
  $Stages.fullNotifications = if ($RefreshAll) { 1 } else { 0 }
  foreach ($shortcutPath in $resolvedShortcutPaths) {
    $stageTimer = [Diagnostics.Stopwatch]::StartNew()
    $pointer = [Runtime.InteropServices.Marshal]::StringToHGlobalUni([string]$shortcutPath)
    $memoryMs += $stageTimer.Elapsed.TotalMilliseconds
    try {
      $stageTimer.Restart()
      [DesktopD6.NativeShell]::SHChangeNotify(0x00002000, $targetNotifyFlags, $pointer, [IntPtr]::Zero)
      $targetNotificationMs += $stageTimer.Elapsed.TotalMilliseconds
    }
    finally {
      $stageTimer.Restart()
      [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer)
      $memoryMs += $stageTimer.Elapsed.TotalMilliseconds
    }
  }
  if ($RefreshAll) {
    $stageTimer = [Diagnostics.Stopwatch]::StartNew()
    [DesktopD6.NativeShell]::SHChangeNotify(0x08000000, 0x1000, [IntPtr]::Zero, [IntPtr]::Zero)
    $fullNotificationMs += $stageTimer.Elapsed.TotalMilliseconds
  }
  $Stages.memoryMs = [Math]::Round($memoryMs, 3)
  $Stages.targetNotifyMs = [Math]::Round($targetNotificationMs, 3)
  $Stages.fullNotifyMs = [Math]::Round($fullNotificationMs, 3)
  $Stages.notifyMs = [Math]::Round($targetNotificationMs + $fullNotificationMs, 3)
}

$initializationTimer = [Diagnostics.Stopwatch]::StartNew()
$stageTimer = [Diagnostics.Stopwatch]::StartNew()
Add-Type -Namespace DesktopD6 -Name NativeShell -MemberDefinition '[DllImport("shell32.dll")] public static extern void SHChangeNotify(uint wEventId, uint uFlags, IntPtr dwItem1, IntPtr dwItem2);'
$nativeCompileMs = Get-ElapsedMilliseconds $stageTimer
$stageTimer.Restart()
$desktopD6Shell = New-Object -ComObject WScript.Shell
$comCreateMs = Get-ElapsedMilliseconds $stageTimer
$stageTimer.Restart()
$desktopD6VerifyShell = New-Object -ComObject WScript.Shell
$verifyComCreateMs = Get-ElapsedMilliseconds $stageTimer
$desktopD6LinkCache = @{}
Send-DesktopD6Message ([ordered]@{
  type = 'ready'
  workerPid = $PID
  initializationMs = Get-ElapsedMilliseconds $initializationTimer
  stages = [ordered]@{ nativeCompileMs = $nativeCompileMs; comCreateMs = $comCreateMs; verifyComCreateMs = $verifyComCreateMs }
})

while (($line = [Console]::In.ReadLine()) -ne $null) {
  if ([String]::IsNullOrWhiteSpace($line)) { continue }
  $requestTimer = [Diagnostics.Stopwatch]::StartNew()
  $request = $null
  $link = $null
  $verifyLink = $null
  $stages = [ordered]@{}
  try {
    $request = $line | ConvertFrom-Json
    $requestId = [string]$request.id
    if ($request.action -eq 'shutdown') {
      Send-DesktopD6Message ([ordered]@{ type = 'response'; id = $requestId; ok = $true; workerDurationMs = Get-ElapsedMilliseconds $requestTimer })
      break
    }

    if ($request.action -eq 'read') {
      Remove-DesktopD6CachedLink ([string]$request.shortcutPath)
      $stageTimer.Restart()
      $link = $desktopD6VerifyShell.CreateShortcut([string]$request.shortcutPath)
      $stages.shortcutOpenMs = Get-ElapsedMilliseconds $stageTimer
      $stages.cacheInvalidated = $true
      $result = [ordered]@{ TargetPath = [string]$link.TargetPath; IconLocation = [string]$link.IconLocation }
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) } catch {}
      $link = $null
    }
    elseif ($request.action -eq 'write' -or $request.action -eq 'writeAndRefresh') {
      $useCache = [bool]$request.cacheShortcut
      $link = Get-DesktopD6WritableLink ([string]$request.shortcutPath) $useCache $stages
      $stageTimer.Restart()
      $link.IconLocation = [string]$request.iconLocation
      $stages.propertySetMs = Get-ElapsedMilliseconds $stageTimer
      $stageTimer.Restart()
      $link.Save()
      $stages.shortcutSaveMs = Get-ElapsedMilliseconds $stageTimer
      if (-not $useCache) {
        try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) } catch {}
        $link = $null
      }
      $stageTimer.Restart()
      $verifyLink = $desktopD6VerifyShell.CreateShortcut([string]$request.shortcutPath)
      $result = [ordered]@{ TargetPath = [string]$verifyLink.TargetPath; IconLocation = [string]$verifyLink.IconLocation }
      $stages.verifyOpenMs = Get-ElapsedMilliseconds $stageTimer
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($verifyLink) } catch {}
      $verifyLink = $null
      if ($request.action -eq 'writeAndRefresh') {
        Invoke-DesktopD6Refresh -ShortcutPaths @([string]$request.shortcutPath) -RefreshAll $false -Stages $stages
      }
    }
    elseif ($request.action -eq 'refresh') {
      Invoke-DesktopD6Refresh -ShortcutPaths @($request.shortcutPaths) -RefreshAll ([bool]$request.refreshAll) -Stages $stages
      $result = [ordered]@{ notified = @($request.shortcutPaths).Count }
    }
    elseif ($request.action -eq 'invalidate') {
      if ([String]::IsNullOrWhiteSpace([string]$request.shortcutPath)) { Clear-DesktopD6CachedLinks }
      else { Remove-DesktopD6CachedLink ([string]$request.shortcutPath) }
      $result = [ordered]@{ invalidated = $true }
    }
    else {
      throw "未知的工作进程操作：$($request.action)"
    }

    Send-DesktopD6Message ([ordered]@{
      type = 'response'; id = $requestId; ok = $true; result = $result
      workerDurationMs = Get-ElapsedMilliseconds $requestTimer; stages = $stages
    })
  }
  catch {
    if ($null -ne $request -and [bool]$request.cacheShortcut) {
      Remove-DesktopD6CachedLink ([string]$request.shortcutPath)
      $link = $null
    }
    if ($null -ne $link) {
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link) } catch {}
    }
    if ($null -ne $verifyLink) {
      try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($verifyLink) } catch {}
    }
    $failedId = if ($null -ne $request) { [string]$request.id } else { '' }
    Send-DesktopD6Message ([ordered]@{
      type = 'response'; id = $failedId; ok = $false; error = $_.Exception.Message
      workerDurationMs = Get-ElapsedMilliseconds $requestTimer; stages = $stages
    })
  }
}

Clear-DesktopD6CachedLinks
if ($null -ne $desktopD6Shell) {
  try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktopD6Shell) } catch {}
}
if ($null -ne $desktopD6VerifyShell) {
  try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($desktopD6VerifyShell) } catch {}
}
`;

function elapsedMs(startedAt) {
  return Math.round(Number(process.hrtime.bigint() - startedAt) / 1e3) / 1e3;
}

class PowerShellWorker {
  constructor(options = {}) {
    this.spawnProcess = options.spawnProcess || spawn;
    this.log = options.log || (() => {});
    this.getOperationId = options.getOperationId || (() => undefined);
    this.startupTimeoutMs = options.startupTimeoutMs || 5000;
    this.requestTimeoutMs = options.requestTimeoutMs || 5000;
    this.child = null;
    this.readyPromise = null;
    this.pending = new Map();
    this.sequence = 0;
    this.generation = 0;
    this.stopping = false;
  }

  start() {
    if (this.stopping) return Promise.reject(new Error('PowerShell 工作进程正在关闭。'));
    if (this.readyPromise) return this.readyPromise;

    const startedAt = process.hrtime.bigint();
    const generation = ++this.generation;
    const encodedCommand = Buffer.from(WORKER_SCRIPT, 'utf16le').toString('base64');
    let child;
    try {
      child = this.spawnProcess('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
        '-EncodedCommand', encodedCommand
      ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      return Promise.reject(error);
    }

    this.child = child;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const startupTimer = setTimeout(() => {
      const error = new Error(`PowerShell 工作进程启动超时（${this.startupTimeoutMs} ms）。`);
      this._terminate(generation, child, error);
      child.kill();
    }, this.startupTimeoutMs);
    startupTimer.unref?.();
    this.startupTimer = startupTimer;

    child.once('spawn', () => {
      this.log('powershell.worker.spawn', { durationMs: elapsedMs(startedAt) });
    });
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString('utf8');
      let newline;
      while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
        const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        this._handleLine(generation, child, line, startedAt);
      }
    });
    child.stderr.on('data', chunk => { stderrBuffer += chunk.toString('utf8'); });
    child.once('error', error => this._terminate(generation, child, error));
    child.once('exit', (code, signal) => {
      if (stderrBuffer.trim()) this.log('powershell.worker.stderr', { message: stderrBuffer.trim() });
      this._terminate(generation, child, new Error(`PowerShell 工作进程已退出（code=${code}, signal=${signal || 'none'}）。`));
    });
    return this.readyPromise;
  }

  async request(action, payload = {}) {
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await this.start();
        return await this._send(action, payload);
      } catch (error) {
        lastError = error;
        if (this.stopping || error.retryable === false || attempt === 1) break;
        this._discardCurrent(error);
      }
    }
    throw lastError;
  }

  _send(action, payload) {
    const child = this.child;
    const generation = this.generation;
    if (!child || !this.readyPromise) return Promise.reject(new Error('PowerShell 工作进程尚未就绪。'));
    const id = `${process.pid}-${Date.now()}-${++this.sequence}`;
    const startedAt = process.hrtime.bigint();
    const operationId = this.getOperationId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error(`PowerShell 操作 ${action} 超时（${this.requestTimeoutMs} ms）。`);
        this.pending.delete(id);
        reject(error);
        this._discardCurrent(error);
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, action, startedAt, generation, operationId });
      const line = `${JSON.stringify({ id, action, ...payload })}\n`;
      const failWrite = error => {
        if (!this.pending.has(id)) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
        if (this.child === child && this.generation === generation) this._discardCurrent(error);
      };
      try {
        child.stdin.write(line, 'utf8', error => {
          if (error) failWrite(error);
        });
      } catch (error) {
        failWrite(error);
      }
    });
  }

  _handleLine(generation, child, line, startedAt) {
    if (generation !== this.generation || child !== this.child || !line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.log('powershell.worker.protocol.error', { message: line.slice(0, 1000) });
      return;
    }
    if (message.type === 'ready') {
      clearTimeout(this.startupTimer);
      this.log('powershell.worker.ready', {
        durationMs: elapsedMs(startedAt),
        workerPid: message.workerPid,
        initializationMs: message.initializationMs,
        stages: message.stages
      });
      this.readyResolve?.(message);
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (message.type !== 'response') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    const details = {
      operationId: pending.operationId,
      action: pending.action,
      durationMs: elapsedMs(pending.startedAt),
      workerDurationMs: message.workerDurationMs,
      stages: message.stages
    };
    if (message.ok) {
      this.log('powershell.worker.complete', details);
      pending.resolve(message.result);
    } else {
      const error = new Error(message.error || `PowerShell 操作 ${pending.action} 失败。`);
      error.retryable = false;
      this.log('powershell.worker.request.error', { ...details, message: error.message });
      pending.reject(error);
    }
  }

  _terminate(generation, child, error) {
    if (generation !== this.generation || child !== this.child) return;
    clearTimeout(this.startupTimer);
    this.readyReject?.(error);
    this.readyResolve = null;
    this.readyReject = null;
    this.readyPromise = null;
    this.child = null;
    for (const [id, pending] of this.pending) {
      if (pending.generation !== generation) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }

  _discardCurrent(error) {
    const child = this.child;
    if (!child) return;
    this._terminate(this.generation, child, error);
    child.kill();
  }

  stop() {
    this.stopping = true;
    const child = this.child;
    if (!child) return;
    this._terminate(this.generation, child, new Error('PowerShell 工作进程已关闭。'));
    child.kill();
  }
}

module.exports = { PowerShellWorker, WORKER_SCRIPT };
