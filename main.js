const { app, BrowserWindow, ipcMain, Menu, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { PerformanceLog } = require('./performance-log');
const { PowerShellWorker } = require('./powershell-worker');

const isWindows = process.platform === 'win32';
let win;
let collectiblePool;
let writableCacheFolder;
const pendingShortcutUpdates = new Map();
const performanceLogger = new PerformanceLog(logPath());
const powerShellWorker = new PowerShellWorker({
  log: (event, details) => performanceLog(event, details),
  getOperationId: () => performanceLogger.operationId()
});

function logFolder() {
  return path.join(app.isPackaged ? path.dirname(process.execPath) : app.getAppPath(), 'log');
}

function logPath() {
  return path.join(logFolder(), 'desktop-d6.log');
}

function performanceLog(event, details = {}) {
  performanceLogger.write(event, details);
}

function elapsedMs(startedAt) {
  return Number(process.hrtime.bigint() - startedAt) / 1e6;
}

function statePath() {
  return path.join(app.getPath('userData'), 'desktop-state.json');
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    return { selectedShortcutPath: null, loggingEnabled: false, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch {
    return { selectedShortcutPath: null, loggingEnabled: false };
  }
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
  performanceLogger.enabled = Boolean(settings.loggingEnabled);
}

function defaultCacheFolder() {
  const installFolder = app.isPackaged ? path.dirname(process.execPath) : app.getAppPath();
  return path.join(installFolder, 'desktop-d6-cache');
}

function cacheFolder() {
  return readSettings().cacheFolder || defaultCacheFolder();
}

function prepareWritableFolder(folder) {
  fs.mkdirSync(folder, { recursive: true });
  const probe = path.join(folder, `.write-test-${process.pid}`);
  fs.writeFileSync(probe, '');
  fs.unlinkSync(probe);
  return folder;
}

function ensureCacheFolder() {
  const settings = readSettings();
  const folder = settings.cacheFolder || defaultCacheFolder();
  if (writableCacheFolder === folder) return folder;
  try {
    writableCacheFolder = prepareWritableFolder(folder);
    return writableCacheFolder;
  } catch (error) {
    if (!settings.cacheFolder) {
      const fallback = path.join(app.getPath('userData'), 'desktop-d6-cache');
      try {
        writableCacheFolder = prepareWritableFolder(fallback);
        return writableCacheFolder;
      } catch {}
    }
    throw new Error(`无法写入图标缓存目录：${folder}\n\n请在右键菜单中选择其他缓存位置。\n${error.message}`);
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return { entries: [] };
  }
}

function writeState(state) {
  const startedAt = process.hrtime.bigint();
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  const tempPath = `${statePath()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tempPath, statePath());
  performanceLog('state.write', { durationMs: elapsedMs(startedAt), entries: state.entries?.length || 0 });
}

function desktopFolders() {
  const folders = [app.getPath('desktop')];
  const publicDesktop = process.env.PUBLIC ? path.join(process.env.PUBLIC, 'Desktop') : null;
  if (publicDesktop && fs.existsSync(publicDesktop)) folders.push(publicDesktop);
  return [...new Set(folders)];
}

function collectibleFolder() {
  const candidates = app.isPackaged
    ? [
        path.join(path.dirname(process.execPath), 'collectibles'),
        path.join(process.resourcesPath, 'collectibles'),
        path.join(app.getPath('userData'), 'collectibles')
      ]
    : [path.join(app.getAppPath(), 'collectibles')];
  const existing = candidates.find(folder => fs.existsSync(folder));
  if (existing) return existing;
  const fallback = candidates[candidates.length - 1];
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

function collectibleFiles() {
  if (collectiblePool) return [...collectiblePool];
  const folder = collectibleFolder();
  collectiblePool = fs.readdirSync(folder)
    .filter(name => /^collectibles_\d+_.+\.png$/i.test(name))
    .map(name => path.join(folder, name));
  return [...collectiblePool];
}

function clearCollectibleCache() {
  collectiblePool = undefined;
}

function shuffle(items) {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function pngToIco(pngBuffer) {
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (pngBuffer.length < 24 || !pngBuffer.subarray(0, 8).equals(pngSignature)) {
    throw new Error('道具图标不是有效的 PNG 文件。');
  }
  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  if (width !== 32 || height !== 32) {
    throw new Error(`道具图标尺寸必须是 32x32，当前是 ${width}x${height}。`);
  }
  // A 32x32 PNG can be embedded directly in an ICO container.
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(32, 0);
  entry.writeUInt8(32, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(pngBuffer.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([header, entry, pngBuffer]);
}

async function changeShortcutIcon(shortcutPath, iconPath) {
  if (!fs.existsSync(iconPath)) throw new Error(`图标文件不存在：${iconPath}`);
  const iconLocation = iconPath.includes(',') ? `"${iconPath}",0` : `${iconPath},0`;
  const saved = await powerShellWorker.request('write', { shortcutPath, iconLocation });
  const savedIcon = String(saved.IconLocation || '').replace(/[\"']/g, '').toLowerCase();
  if (!savedIcon.includes(iconPath.toLowerCase()) && !savedIcon.includes(path.basename(iconPath).toLowerCase())) {
    throw new Error(`快捷方式没有保存新的图标路径：${shortcutPath}`);
  }
}

async function changeShortcutIconFast(shortcutPath, iconPath) {
  const startedAt = process.hrtime.bigint();
  if (!fs.existsSync(iconPath)) throw new Error(`图标文件不存在：${iconPath}`);
  const iconLocation = iconPath.includes(',') ? `"${iconPath}",0` : `${iconPath},0`;
  const saved = await powerShellWorker.request('writeAndRefresh', { shortcutPath, iconLocation, cacheShortcut: true });
  const savedIcon = String(saved.IconLocation || '').replace(/["']/g, '').toLowerCase();
  if (!savedIcon.includes(iconPath.toLowerCase()) && !savedIcon.includes(path.basename(iconPath).toLowerCase())) {
    throw new Error(`快捷方式没有保存新的图标路径：${shortcutPath}`);
  }
  performanceLog('shortcut.write.fast', { durationMs: elapsedMs(startedAt), shortcutPath, iconPath });
}

function queueShortcutIconUpdate(shortcutPath, iconPath) {
  const queuedAt = process.hrtime.bigint();
  performanceLog('shortcut.queue', { shortcutPath, iconPath });
  const previous = pendingShortcutUpdates.get(shortcutPath.toLowerCase()) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(() => {
      performanceLog('shortcut.queue.wait', { durationMs: elapsedMs(queuedAt), shortcutPath });
      return performanceLogger.measure('shortcut.write_and_refresh', () => changeShortcutIconFast(shortcutPath, iconPath), { shortcutPath, iconPath });
    })
    .then(() => performanceLog('shortcut.queue.complete', { durationMs: elapsedMs(queuedAt), shortcutPath }))
    .catch(error => {
      performanceLog('shortcut.queue.error', { durationMs: elapsedMs(queuedAt), shortcutPath, message: error.message });
      dialog.showErrorBox('随机图标失败', `${path.basename(shortcutPath)}：${error.message}`);
    })
    .finally(() => {
      if (pendingShortcutUpdates.get(shortcutPath.toLowerCase()) === next) {
        pendingShortcutUpdates.delete(shortcutPath.toLowerCase());
      }
    });
  pendingShortcutUpdates.set(shortcutPath.toLowerCase(), next);
}

async function restoreShortcutIcon(shortcutPath, iconLocation) {
  const saved = await powerShellWorker.request('write', { shortcutPath, iconLocation: iconLocation || '' });
  const expected = normalizedIconLocation(iconLocation);
  const actual = normalizedIconLocation(saved.IconLocation);
  if (expected ? actual !== expected : actual !== '' && actual !== ',0') {
    throw new Error('快捷方式没有保存默认图标位置。');
  }
}

function defaultIconLocation(entry) {
  const original = normalizedIconLocation(entry.originalIconLocation);
  if (original && original !== ',0' && !isGeneratedIconLocation(original)) return entry.originalIconLocation;
  return entry.originalTargetPath ? `${entry.originalTargetPath},0` : '';
}

async function readShortcut(shortcutPath) {
  return powerShellWorker.request('read', { shortcutPath });
}

async function refreshExplorer(shortcutPaths = [], refreshAll = false) {
  const startedAt = process.hrtime.bigint();
  if (shortcutPaths.length > 0 || refreshAll) {
    await powerShellWorker.request('refresh', { shortcutPaths, refreshAll });
  }
  performanceLog('explorer.refresh', { durationMs: elapsedMs(startedAt), shortcutCount: shortcutPaths.length, refreshAll });
}

function normalizeState(state) {
  const entries = Array.isArray(state.entries) ? state.entries : [];
  return {
    ...state,
    entries: entries.filter(entry => entry && entry.shortcutPath).map(entry => ({
      ...entry,
      generatedIcons: Array.isArray(entry.generatedIcons)
        ? entry.generatedIcons
        : (entry.generatedIcon ? [entry.generatedIcon] : [])
    }))
  };
}

function persistState(entriesByPath) {
  writeState({ changedAt: new Date().toISOString(), entries: [...entriesByPath.values()] });
}

function normalizedIconLocation(value) {
  return String(value || '')
    .replace(/[\"']/g, '')
    .replace(/\s*,\s*/g, ',')
    .trim()
    .toLowerCase();
}

function isGeneratedIconLocation(value) {
  const location = normalizedIconLocation(value).split(',')[0];
  return /(?:desktop-d6-cache|generated-icons)[\\/][^\\/]+\.ico$/i.test(location);
}

function iconFileFromLocation(value) {
  const location = String(value || '').replace(/[\"']/g, '').split(',')[0].trim();
  return isGeneratedIconLocation(location) ? location : null;
}

async function desktopCandidates() {
  const candidates = [];
  for (const folder of desktopFolders()) {
    let files = [];
    try { files = fs.readdirSync(folder, { withFileTypes: true }); } catch { continue; }
    for (const file of files) {
      if (!file.isFile() || !file.name.toLowerCase().endsWith('.lnk')) continue;
      const shortcutPath = path.join(folder, file.name);
      let info;
      try { info = await readShortcut(shortcutPath); } catch { continue; }
      if (isD6Shortcut(info, shortcutPath)) continue;
      candidates.push({ shortcutPath, info });
    }
  }
  return candidates;
}

function isD6Shortcut(info, shortcutPath) {
  const values = `${shortcutPath} ${info.TargetPath || ''}`.toLowerCase();
  return values.includes('desktop d6') || values.includes('desktop-d6') || values.includes('d6.exe');
}

async function randomizeDesktop(selectedShortcutPath = null) {
  return performanceLogger.operation('randomize', () => runRandomizeDesktop(selectedShortcutPath));
}

async function runRandomizeDesktop(selectedShortcutPath = null) {
  const startedAt = process.hrtime.bigint();
  if (!isWindows) throw new Error('此工具目前只支持 Windows。');
  const pool = performanceLogger.sync('collectibles.list.shuffle', () => shuffle(collectibleFiles()));
  if (pool.length === 0) {
    throw new Error('道具文件夹中没有可用 PNG。请添加符合 collectibles_数字_名称.png 格式的 32x32 图标。');
  }
  const iconFolder = performanceLogger.sync('cache.prepare', ensureCacheFolder);
  const settings = performanceLogger.sync('settings.read', readSettings);
  selectedShortcutPath = selectedShortcutPath || settings.selectedShortcutPath || null;
  performanceLog('randomize.mode', { mode: selectedShortcutPath ? 'single' : 'global', selectedShortcutPath });
  if (selectedShortcutPath && !fs.existsSync(selectedShortcutPath)) {
    writeSettings({
      ...settings,
      selectedShortcutPath: null,
      selectedOriginalIconLocation: null,
      selectedOriginalTargetPath: null
    });
    try { await powerShellWorker.request('invalidate'); } catch {}
    selectedShortcutPath = null;
  }
  const state = performanceLogger.sync('state.read', () => normalizeState(readState()));
  const entriesByPath = new Map(state.entries.map(entry => [entry.shortcutPath.toLowerCase(), entry]));
  const selectedKey = selectedShortcutPath ? path.resolve(selectedShortcutPath).toLowerCase() : null;
  const selectedBaseline = selectedKey && settings.selectedShortcutPath
    && path.resolve(settings.selectedShortcutPath).toLowerCase() === selectedKey
    ? settings
    : null;
  const changedPaths = [];
  const errors = [];
  const targetsStartedAt = process.hrtime.bigint();
  let targets;
  if (selectedShortcutPath) {
    let info;
    if (selectedBaseline?.selectedOriginalTargetPath) {
      info = {
        TargetPath: selectedBaseline.selectedOriginalTargetPath,
        IconLocation: selectedBaseline.selectedOriginalIconLocation || ''
      };
    } else {
      try {
        info = await performanceLogger.measure('shortcut.read', () => readShortcut(selectedShortcutPath), { shortcutPath: selectedShortcutPath });
      } catch (error) {
        throw new Error(`无法读取所选快捷方式：${error.message}`);
      }
    }
    if (isD6Shortcut(info, selectedShortcutPath)) {
      throw new Error('所选文件不能是 D6 自身的快捷方式。');
    }
    targets = [{ shortcutPath: selectedShortcutPath, info }];
  } else {
    targets = await performanceLogger.measure('desktop.scan', desktopCandidates);
  }
  performanceLog('targets.resolve', { durationMs: elapsedMs(targetsStartedAt), count: targets.length, fromSavedBaseline: Boolean(selectedBaseline?.selectedOriginalTargetPath) });

  if (targets.length === 0) throw new Error('桌面上没有可处理的快捷方式。');

  for (let iconIndex = 0; iconIndex < targets.length; iconIndex++) {
    const { shortcutPath, info } = targets[iconIndex];
    const collectible = pool[iconIndex % pool.length];
    const token = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const generatedIcon = path.join(iconFolder, `${token}.ico`);
    const icoStartedAt = process.hrtime.bigint();
    const png = performanceLogger.sync('png.read', () => fs.readFileSync(collectible), { collectible });
    const ico = performanceLogger.sync('ico.convert', () => pngToIco(png), { collectible });
    performanceLogger.sync('ico.write', () => fs.writeFileSync(generatedIcon, ico), { generatedIcon, bytes: ico.length });
    performanceLog('ico.generate', { durationMs: elapsedMs(icoStartedAt), collectible, generatedIcon });
    const key = shortcutPath.toLowerCase();
    const existing = entriesByPath.get(key);
    const previousGeneratedIcon = existing?.generatedIcon;
    if (existing) {
      if (selectedBaseline) {
        if (!existing.originalIconLocation && selectedBaseline.selectedOriginalIconLocation) {
          existing.originalIconLocation = selectedBaseline.selectedOriginalIconLocation;
        }
        if (!existing.originalTargetPath && selectedBaseline.selectedOriginalTargetPath) {
          existing.originalTargetPath = selectedBaseline.selectedOriginalTargetPath;
        }
      }
      if (!existing.originalTargetPath && info.TargetPath) existing.originalTargetPath = info.TargetPath;
      if (!existing.originalIconLocation && !isGeneratedIconLocation(info.IconLocation) && info.IconLocation) {
        existing.originalIconLocation = info.IconLocation;
      }
      existing.generatedIcons.push(generatedIcon);
      existing.generatedIcon = generatedIcon;
    } else {
      entriesByPath.set(key, {
        shortcutPath,
        originalIconLocation: selectedBaseline?.selectedOriginalIconLocation
          || (isGeneratedIconLocation(info.IconLocation) ? '' : (info.IconLocation || '')),
        originalTargetPath: selectedBaseline?.selectedOriginalTargetPath || info.TargetPath || '',
        generatedIcon,
        generatedIcons: [generatedIcon]
      });
    }
    try {
      performanceLogger.sync('baseline.persist', () => persistState(entriesByPath), { shortcutPath });
      if (selectedShortcutPath) {
        queueShortcutIconUpdate(shortcutPath, generatedIcon);
      } else {
        await performanceLogger.measure('shortcut.write.verify', () => changeShortcutIcon(shortcutPath, generatedIcon), { shortcutPath, iconPath: generatedIcon });
      }
      changedPaths.push(shortcutPath);
    } catch (error) {
      performanceLog('randomize.item.error', { shortcutPath, message: error.message });
      let rolledBack = false;
      try {
        await performanceLogger.measure('shortcut.rollback', () => restoreShortcutIcon(shortcutPath, defaultIconLocation({
          originalIconLocation: info.IconLocation,
          originalTargetPath: info.TargetPath
        })), { shortcutPath });
        rolledBack = true;
      } catch {}
      if (rolledBack) {
        if (existing) {
          existing.generatedIcons = existing.generatedIcons.filter(iconPath => iconPath !== generatedIcon);
          existing.generatedIcon = previousGeneratedIcon;
        } else {
          entriesByPath.delete(key);
        }
        persistState(entriesByPath);
        try { fs.unlinkSync(generatedIcon); } catch {}
      }
      errors.push(`${path.basename(shortcutPath)}：${error.message}${rolledBack ? '' : '；自动回滚失败，已保留恢复记录和图标文件。'}`);
    }
  }

  if (changedPaths.length > 0) {
    if (!selectedShortcutPath) {
      await refreshExplorer(changedPaths, changedPaths.length > 1);
    }
  }
  if (changedPaths.length === 0 && errors.length > 0) throw new Error(errors.join('\n'));
  performanceLog('randomize.dispatch.complete', { durationMs: elapsedMs(startedAt), scheduled: Boolean(selectedShortcutPath), count: changedPaths.length, errors: errors.length, selectedShortcutPath });
  return { changed: changedPaths.length, errors };
}

async function restoreDesktop() {
  return performanceLogger.operation('restore', runRestoreDesktop);
}

async function runRestoreDesktop() {
  const startedAt = process.hrtime.bigint();
  if (pendingShortcutUpdates.size > 0) {
    await performanceLogger.measure('restore.queue.wait', () => Promise.all([...pendingShortcutUpdates.values()].map(task => task.catch(() => {}))));
  }
  const state = performanceLogger.sync('state.read', () => normalizeState(readState()));
  const entriesByPath = new Map(state.entries.map(entry => [entry.shortcutPath.toLowerCase(), entry]));
  const selectedSettings = readSettings();
  const selectedPath = selectedSettings.selectedShortcutPath;
  if (selectedPath && fs.existsSync(selectedPath)) {
    const key = path.resolve(selectedPath).toLowerCase();
    if (!entriesByPath.has(key)) {
      try {
        const info = await readShortcut(selectedPath);
        const generatedIcon = iconFileFromLocation(info.IconLocation);
        if (generatedIcon && info.TargetPath) {
          entriesByPath.set(key, {
            shortcutPath: selectedPath,
            originalIconLocation: selectedSettings.selectedOriginalIconLocation || '',
            originalTargetPath: selectedSettings.selectedOriginalTargetPath || info.TargetPath,
            generatedIcon,
            generatedIcons: [generatedIcon]
          });
        }
      } catch {}
    }
  }
  if (entriesByPath.size === 0) {
    for (const candidate of await desktopCandidates()) {
      const generatedIcon = iconFileFromLocation(candidate.info.IconLocation);
      if (generatedIcon && candidate.info.TargetPath) {
        entriesByPath.set(candidate.shortcutPath.toLowerCase(), {
          shortcutPath: candidate.shortcutPath,
          originalIconLocation: '',
          originalTargetPath: candidate.info.TargetPath,
          generatedIcon,
          generatedIcons: [generatedIcon]
        });
      }
    }
  }
  for (const entry of entriesByPath.values()) {
    if (!entry.originalTargetPath) {
      try {
        const info = await readShortcut(entry.shortcutPath);
        if (info.TargetPath) entry.originalTargetPath = info.TargetPath;
      } catch {}
    }
  }
  let restored = 0;
  const restoredEntries = [];
  const remainingEntries = [];
  const errors = [];
  for (const entry of entriesByPath.values()) {
    if (!fs.existsSync(entry.shortcutPath)) {
      remainingEntries.push(entry);
      errors.push(`${path.basename(entry.shortcutPath)}：快捷方式不存在或已被移动。`);
      continue;
    }
    try {
      await performanceLogger.measure('shortcut.restore.verify', () => restoreShortcutIcon(entry.shortcutPath, defaultIconLocation(entry)), { shortcutPath: entry.shortcutPath });
      restored++;
      restoredEntries.push(entry);
    } catch (error) {
      remainingEntries.push(entry);
      errors.push(`${path.basename(entry.shortcutPath)}：${error.message}`);
    }
  }
  performanceLogger.sync('state.persist.remaining', () => writeState({ entries: remainingEntries }));
  await refreshExplorer(restoredEntries.map(entry => entry.shortcutPath));
  for (const entry of restoredEntries) {
    for (const iconPath of entry.generatedIcons) {
      try { performanceLogger.sync('ico.cleanup', () => fs.unlinkSync(iconPath), { iconPath }); } catch {}
    }
  }
  performanceLog('restore.complete', { durationMs: elapsedMs(startedAt), restored, errors: errors.length });
  return { restored, errors };
}

async function chooseCacheFolder() {
  const result = await dialog.showOpenDialog(win, {
    title: '选择图标缓存位置',
    defaultPath: cacheFolder(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return;
  const selected = result.filePaths[0];
  const settings = readSettings();
  writeSettings({ ...settings, cacheFolder: selected });
  try {
    ensureCacheFolder();
  } catch (error) {
    writeSettings(settings);
    throw error;
  }
}

async function openCacheFolder() {
  const folder = ensureCacheFolder();
  const error = await shell.openPath(folder);
  if (error) throw new Error(error);
}

async function chooseShortcutTarget() {
  return performanceLogger.operation('target.select', runChooseShortcutTarget);
}

async function runChooseShortcutTarget() {
  const result = await dialog.showOpenDialog(win, {
    title: '选择要随机的桌面快捷方式',
    defaultPath: app.getPath('desktop'),
    filters: [{ name: 'Windows 快捷方式', extensions: ['lnk'] }],
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const selectedPath = result.filePaths[0];
  await powerShellWorker.request('invalidate');
  const info = await performanceLogger.measure('target.read.baseline', () => readShortcut(selectedPath), { shortcutPath: selectedPath });
  if (isD6Shortcut(info, selectedPath)) {
    throw new Error('不能选择 D6 自身的快捷方式。');
  }
  performanceLogger.sync('target.save.baseline', () => writeSettings({
    ...readSettings(),
    selectedShortcutPath: selectedPath,
    selectedOriginalIconLocation: isGeneratedIconLocation(info.IconLocation) ? '' : (info.IconLocation || ''),
    selectedOriginalTargetPath: info.TargetPath || ''
  }), { shortcutPath: selectedPath });
  return selectedPath;
}

function showRandomizeResult(result) {
  if (result.errors.length > 0) {
    dialog.showMessageBox(win, {
      type: 'warning',
      title: '部分图标未能修改',
      message: `已修改 ${result.changed} 个快捷方式，${result.errors.length} 个失败。`,
      detail: result.errors.join('\n')
    });
  } else {
    dialog.showMessageBox(win, {
      type: 'info',
      title: '随机完成',
      message: `已修改 ${result.changed} 个快捷方式。`
    });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 128,
    height: 164,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  win.setAlwaysOnTop(true, 'floating');
  win.loadFile('index.html');
  win.webContents.on('context-menu', event => {
    event.preventDefault();
  });
}

function showMenu() {
  const settings = readSettings();
  const selectedTarget = settings.selectedShortcutPath
    ? path.basename(settings.selectedShortcutPath)
    : '';
  Menu.buildFromTemplate([
    {
      label: '恢复桌面默认图标',
      click: async () => {
        try {
          const result = await restoreDesktop();
          dialog.showMessageBox(win, result.errors.length > 0 ? {
            type: 'warning',
            title: '部分图标未能恢复',
            message: `已恢复 ${result.restored} 个快捷方式，${result.errors.length} 个失败。`,
            detail: result.errors.join('\n')
          } : {
            type: 'info',
            title: '恢复完成',
            message: result.restored > 0 ? `已恢复 ${result.restored} 个快捷方式。` : '没有需要恢复的快捷方式。'
          });
        } catch (error) {
          dialog.showErrorBox('恢复失败', error.message);
        }
      }
    },
    {
      label: '手动选择快捷方式…',
      click: async () => {
        try {
          await chooseShortcutTarget();
        } catch (error) {
          dialog.showErrorBox('设置手动目标失败', error.message);
        }
      }
    },
    {
      label: selectedTarget ? `当前手动目标：${selectedTarget}` : '当前手动目标：未设置',
      enabled: false
    },
    {
      label: '切换为全局随机',
      enabled: Boolean(settings.selectedShortcutPath),
      click: async () => {
        writeSettings({
          ...readSettings(),
          selectedShortcutPath: null,
          selectedOriginalIconLocation: null,
          selectedOriginalTargetPath: null
        });
        try { await powerShellWorker.request('invalidate'); } catch {}
      }
    },
    {
      label: '输出日志',
      type: 'checkbox',
      checked: Boolean(settings.loggingEnabled),
      click: item => {
        try {
          writeSettings({ ...readSettings(), loggingEnabled: item.checked });
          if (item.checked) performanceLog('logging.enabled', { logPath: logPath() });
        } catch (error) {
          dialog.showErrorBox('日志设置失败', error.message);
        }
      }
    },
    { label: '打开道具文件夹', click: () => shell.openPath(collectibleFolder()) },
    { type: 'separator' },
    { label: '设置图标缓存位置…', click: async () => { try { await chooseCacheFolder(); } catch (error) { dialog.showErrorBox('设置失败', error.message); } } },
    { label: '打开图标缓存文件夹', click: async () => { try { await openCacheFolder(); } catch (error) { dialog.showErrorBox('无法打开缓存', error.message); } } },
    {
      label: '恢复默认缓存位置',
      enabled: Boolean(settings.cacheFolder),
      click: () => writeSettings({ ...readSettings(), cacheFolder: undefined })
    },
    { type: 'separator' },
    { label: '退出 D6', role: 'quit' }
  ]).popup({ window: win });
}

app.whenReady().then(async () => {
  performanceLogger.enabled = Boolean(readSettings().loggingEnabled);
  performanceLogger.sync('startup.cache.prepare', ensureCacheFolder);
  performanceLogger.sync('startup.collectibles.preload', collectibleFiles);
  if (isWindows) {
    try {
      await performanceLogger.measure('startup.powershell.worker', () => powerShellWorker.start());
    } catch (error) {
      performanceLog('startup.powershell.worker.error', { message: error.message });
    }
  }
  createWindow();
  ipcMain.handle('randomize-desktop', async () => {
    try {
      const result = await randomizeDesktop();
      if (result.errors.length > 0) showRandomizeResult(result);
      return result.changed;
    }
    catch (error) {
      dialog.showErrorBox('随机图标失败', error.message);
      throw error;
    }
  });
  ipcMain.handle('restore-desktop', async () => (await restoreDesktop()).restored);
  ipcMain.handle('get-window-bounds', () => win.getBounds());
  ipcMain.on('move-window', (_event, x, y) => {
    if (win && !win.isDestroyed()) win.setPosition(Math.round(x), Math.round(y));
  });
  ipcMain.on('show-menu', showMenu);
});

app.on('before-quit', () => {
  powerShellWorker.stop();
  performanceLogger.flush();
});
