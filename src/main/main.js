const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');
const { autoUpdater } = require('electron-updater');

const APP_TITLE = 'Fast Markdown';
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);
const MAX_PYTHON_OUTPUT_BYTES = 1024 * 1024;
const PYTHON_TIMEOUT_MS = 30_000;
const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const UPDATE_CONFIG_FILE = 'update-config.json';
const UPDATE_CHANNEL = 'updater-status';
const AUTO_UPDATE_CHECK_DELAY_MS = 5_000;

let mainWindow = null;
const windowStates = new Map();
let pendingMacOpenFiles = [];
let saveRequestId = 0;
const pendingSaveRequests = new Map();
let updaterEnabled = false;
let updateCheckInProgress = false;
let updateDownloadInProgress = false;
let updateReadyToInstall = false;
let updaterInitialized = false;

function isMarkdownFile(filePath) {
    if (!filePath) {
        return false;
    }

    return MARKDOWN_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function resolveMarkdownPathFromArgs(args) {
    return args.find((arg) => isMarkdownFile(arg) && fsSync.existsSync(arg)) || null;
}

function getAssetPath(...segments) {
    return path.join(__dirname, '..', '..', ...segments);
}

function getRendererPath(...segments) {
    return path.join(__dirname, '..', 'renderer', ...segments);
}

function createWindowState() {
    return {
        filePath: null,
        isDocumentDirty: false,
        forceClosing: false,
        closeInProgress: false
    };
}

function getWindowState(window) {
    if (!window || window.isDestroyed()) {
        return null;
    }

    if (!windowStates.has(window.id)) {
        windowStates.set(window.id, createWindowState());
    }

    return windowStates.get(window.id);
}

function getOpenWindows() {
    return BrowserWindow.getAllWindows().filter((window) => !window.isDestroyed());
}

function getPrimaryWindow() {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow && !focusedWindow.isDestroyed()) {
        return focusedWindow;
    }

    if (mainWindow && !mainWindow.isDestroyed()) {
        return mainWindow;
    }

    return getOpenWindows()[0] || null;
}

function getReusableWindow() {
    return getOpenWindows().find((window) => {
        const state = getWindowState(window);
        return state && !state.filePath && !state.isDocumentDirty;
    }) || null;
}

function shouldOpenFileInNewWindow(window) {
    const state = getWindowState(window);
    return Boolean(state && (state.filePath || state.isDocumentDirty));
}

function getDefaultPdfPath(window, suggestedName = '未命名文档') {
    const filePath = getWindowState(window)?.filePath;
    if (filePath) {
        const parsed = path.parse(filePath);
        return path.join(parsed.dir, `${parsed.name}.pdf`);
    }

    const baseName = path.parse(String(suggestedName || '未命名文档')).name || '未命名文档';
    return path.join(app.getPath('documents'), `${baseName}.pdf`);
}

function sendUpdaterStatus(payload, targetWindow = null) {
    const windows = targetWindow
        ? [targetWindow]
        : getOpenWindows();

    if (windows.length === 0) {
        return;
    }

    windows.forEach((window) => {
        window.webContents.send(UPDATE_CHANNEL, payload);
    });
}

function getUpdateConfigPath() {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, UPDATE_CONFIG_FILE);
    }

    return path.join(__dirname, '..', '..', UPDATE_CONFIG_FILE);
}

function loadUpdateConfig() {
    const envUrl = String(process.env.FAST_MARKDOWN_UPDATE_URL || '').trim();
    if (envUrl) {
        return {
            enabled: true,
            provider: 'generic',
            url: envUrl,
            channel: String(process.env.FAST_MARKDOWN_UPDATE_CHANNEL || 'latest').trim() || 'latest',
            autoDownload: String(process.env.FAST_MARKDOWN_AUTO_DOWNLOAD || '').toLowerCase() === 'true'
        };
    }

    const configPath = getUpdateConfigPath();
    if (!fsSync.existsSync(configPath)) {
        return null;
    }

    try {
        const raw = fsSync.readFileSync(configPath, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
            enabled: Boolean(parsed.enabled),
            provider: String(parsed.provider || 'generic').trim().toLowerCase(),
            url: String(parsed.url || '').trim(),
            channel: String(parsed.channel || 'latest').trim() || 'latest',
            autoDownload: Boolean(parsed.autoDownload)
        };
    } catch {
        return null;
    }
}

async function checkForUpdates(manual = false) {
    if (!updaterEnabled) {
        if (manual) {
            sendUpdaterStatus({
                type: 'disabled',
                message: '自动更新未配置。请先在 update-config.json 中设置更新地址。'
            });
        }
        return { success: false };
    }

    if (updateCheckInProgress) {
        if (manual) {
            sendUpdaterStatus({
                type: 'busy',
                message: '正在检查更新，请稍候。'
            });
        }
        return { success: false };
    }

    try {
        updateCheckInProgress = true;
        await autoUpdater.checkForUpdates();
        return { success: true };
    } catch (err) {
        updateCheckInProgress = false;
        sendUpdaterStatus({
            type: 'error',
            message: err.message || '检查更新失败'
        });
        return { success: false, error: err.message };
    }
}

async function downloadUpdate() {
    if (!updaterEnabled) {
        sendUpdaterStatus({
            type: 'disabled',
            message: '自动更新未配置。请先在 update-config.json 中设置更新地址。'
        });
        return { success: false };
    }

    if (updateReadyToInstall) {
        sendUpdaterStatus({
            type: 'downloaded',
            message: '更新已下载完成，可立即安装。'
        });
        return { success: true };
    }

    if (updateDownloadInProgress) {
        sendUpdaterStatus({
            type: 'busy',
            message: '更新正在下载中，请稍候。'
        });
        return { success: false };
    }

    try {
        updateDownloadInProgress = true;
        await autoUpdater.downloadUpdate();
        return { success: true };
    } catch (err) {
        updateDownloadInProgress = false;
        sendUpdaterStatus({
            type: 'error',
            message: err.message || '下载更新失败'
        });
        return { success: false, error: err.message };
    }
}

async function installDownloadedUpdate() {
    if (!updateReadyToInstall) {
        sendUpdaterStatus({
            type: 'not-ready',
            message: '当前没有可安装的更新。'
        });
        return { success: false };
    }

    const canClose = await ensureAllWindowsCanClose();
    if (!canClose) {
        return { success: false, cancelled: true };
    }

    markAllWindowsForceClosing();
    setImmediate(() => {
        autoUpdater.quitAndInstall(false, true);
    });

    return { success: true };
}

function setupAutoUpdater() {
    if (updaterInitialized) {
        return;
    }

    updaterInitialized = true;
    updateReadyToInstall = false;
    updateCheckInProgress = false;
    updateDownloadInProgress = false;

    if (!app.isPackaged) {
        sendUpdaterStatus({
            type: 'disabled',
            message: '开发模式下不执行自动更新。'
        });
        return;
    }

    const config = loadUpdateConfig();
    const isValid = config
        && config.enabled
        && config.provider === 'generic'
        && Boolean(config.url);

    if (!isValid) {
        updaterEnabled = false;
        sendUpdaterStatus({
            type: 'disabled',
            message: '自动更新未启用，请配置 update-config.json（enabled/url）。'
        });
        return;
    }

    autoUpdater.autoDownload = Boolean(config.autoDownload);
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    autoUpdater.disableWebInstaller = true;
    autoUpdater.setFeedURL({
        provider: 'generic',
        url: config.url,
        channel: config.channel
    });

    autoUpdater.removeAllListeners();

    autoUpdater.on('checking-for-update', () => {
        updateCheckInProgress = true;
        sendUpdaterStatus({ type: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
        updateCheckInProgress = false;
        updateReadyToInstall = false;
        sendUpdaterStatus({
            type: 'available',
            version: info?.version || '',
            releaseDate: info?.releaseDate || ''
        });
    });

    autoUpdater.on('update-not-available', () => {
        updateCheckInProgress = false;
        updateReadyToInstall = false;
        sendUpdaterStatus({ type: 'not-available' });
    });

    autoUpdater.on('download-progress', (progress) => {
        updateDownloadInProgress = true;
        sendUpdaterStatus({
            type: 'downloading',
            percent: Number(progress?.percent || 0)
        });
    });

    autoUpdater.on('update-downloaded', (info) => {
        updateDownloadInProgress = false;
        updateReadyToInstall = true;
        sendUpdaterStatus({
            type: 'downloaded',
            version: info?.version || ''
        });
    });

    autoUpdater.on('error', (err) => {
        updateCheckInProgress = false;
        updateDownloadInProgress = false;
        sendUpdaterStatus({
            type: 'error',
            message: err?.message || '自动更新发生错误'
        });
    });

    updaterEnabled = true;
}

function setWindowTitle(window, filePath = null) {
    if (!window || window.isDestroyed()) {
        return;
    }

    if (!filePath) {
        window.setTitle(APP_TITLE);
        return;
    }

    window.setTitle(`${APP_TITLE} - ${path.basename(filePath)}`);
}

function isSafeExternalUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        return SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol);
    } catch {
        return false;
    }
}

function setupNavigationGuards(window) {
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (isSafeExternalUrl(url)) {
            shell.openExternal(url).catch(() => undefined);
        }

        return { action: 'deny' };
    });

    window.webContents.on('will-navigate', (event, url) => {
        const currentUrl = window.webContents.getURL();
        if (url === currentUrl) {
            return;
        }

        event.preventDefault();
        if (isSafeExternalUrl(url)) {
            shell.openExternal(url).catch(() => undefined);
        }
    });
}

async function requestRendererSave(window) {
    if (!window || window.isDestroyed()) {
        return false;
    }

    const requestId = ++saveRequestId;

    return new Promise((resolve) => {
        const timeout = setTimeout(() => {
            pendingSaveRequests.delete(requestId);
            resolve(false);
        }, PYTHON_TIMEOUT_MS);

        pendingSaveRequests.set(requestId, (success) => {
            clearTimeout(timeout);
            resolve(Boolean(success));
        });

        window.webContents.send('main-request-save', { requestId });
    });
}

async function ensureNoUnsavedChanges(window, action) {
    const state = getWindowState(window);
    if (!state || !state.isDocumentDirty) {
        return true;
    }

    const details = action === 'close'
        ? '当前文档有未保存更改。是否先保存再退出？'
        : '当前文档有未保存更改。是否先保存再继续？';

    const choice = dialog.showMessageBoxSync(window, {
        type: 'warning',
        buttons: ['保存', '不保存', '取消'],
        defaultId: 0,
        cancelId: 2,
        title: '未保存更改',
        message: '检测到未保存内容',
        detail: details,
        noLink: true
    });

    if (choice === 0) {
        return requestRendererSave(window);
    }

    return choice === 1;
}

async function ensureAllWindowsCanClose() {
    for (const window of getOpenWindows()) {
        const canClose = await ensureNoUnsavedChanges(window, 'close');
        if (!canClose) {
            return false;
        }
    }

    return true;
}

function markAllWindowsForceClosing() {
    getOpenWindows().forEach((window) => {
        const state = getWindowState(window);
        if (state) {
            state.forceClosing = true;
        }
    });
}

async function openFileInWindow(window, filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        const state = getWindowState(window);
        if (state) {
            state.filePath = filePath;
            state.isDocumentDirty = false;
        }

        if (window && !window.isDestroyed()) {
            window.webContents.send('file-opened', {
                path: filePath,
                name: path.basename(filePath),
                content
            });
            setWindowTitle(window, filePath);
        }

        return { success: true };
    } catch (err) {
        dialog.showErrorBox('打开文件失败', err.message);
        return { success: false, error: err.message };
    }
}

async function openFileWithGuard(window, filePath, skipDirtyCheck = false) {
    if (!filePath || !fsSync.existsSync(filePath)) {
        return { success: false, error: '文件不存在' };
    }

    if (!skipDirtyCheck) {
        const canProceed = await ensureNoUnsavedChanges(window, 'open');
        if (!canProceed) {
            return { success: false, cancelled: true };
        }
    }

    return openFileInWindow(window, filePath);
}

async function openFileDialog(window) {
    if (!window || window.isDestroyed()) {
        return { success: false, error: '窗口不可用' };
    }

    const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [
            { name: 'Markdown Files', extensions: ['md', 'markdown'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled || result.filePaths.length === 0) {
        return { success: false, cancelled: true };
    }

    const [filePath] = result.filePaths;
    if (shouldOpenFileInNewWindow(window)) {
        createWindow(filePath);
        return { success: true, path: filePath, openedInNewWindow: true };
    }

    return openFileInWindow(window, filePath);
}

async function exportPdf(window, payload) {
    if (!window || window.isDestroyed()) {
        return { success: false, error: '主窗口不可用' };
    }

    const currentFilePath = getWindowState(window)?.filePath;
    const suggestedName = String(payload?.suggestedName || path.basename(currentFilePath || '未命名文档'));

    try {
        const result = await dialog.showSaveDialog(window, {
            title: '导出 PDF',
            buttonLabel: '导出',
            defaultPath: getDefaultPdfPath(window, suggestedName),
            filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
        });

        if (result.canceled || !result.filePath) {
            return { success: false, cancelled: true };
        }

        await window.webContents.executeJavaScript(
            'window.preparePdfExport ? window.preparePdfExport() : Promise.resolve(true)',
            true
        ).catch(() => undefined);
        await window.webContents.executeJavaScript(
            'document.fonts && document.fonts.ready ? document.fonts.ready.then(() => true) : Promise.resolve(true)',
            true
        ).catch(() => undefined);

        const pdfData = await window.webContents.printToPDF({
            printBackground: true,
            pageSize: 'A4',
            marginsType: 1,
            preferCSSPageSize: true
        });

        await fs.writeFile(result.filePath, pdfData);
        return {
            success: true,
            path: result.filePath,
            name: path.basename(result.filePath)
        };
    } catch (err) {
        dialog.showErrorBox('导出 PDF 失败', err.message);
        return { success: false, error: err.message };
    }
}

function parseInputPrompts(code) {
    const inputRegex = /input\s*\(\s*(?:(['"`])(.*?)\1)?\s*\)/g;
    const prompts = [];
    let match;

    while ((match = inputRegex.exec(code)) !== null) {
        prompts.push(match[2] || '请输入:');
    }

    return prompts;
}

async function collectPythonInputs(code, parentWindow) {
    const prompts = parseInputPrompts(code);
    if (prompts.length === 0) {
        return { cancelled: false, values: [] };
    }

    const values = [];
    for (const prompt of prompts) {
        const response = await showInputDialog(prompt, parentWindow);
        if (response.cancelled) {
            return { cancelled: true, values: [] };
        }

        values.push(response.value ?? '');
    }

    return { cancelled: false, values };
}

function buildPythonCode(rawCode, inputValues) {
    return [
        'import builtins',
        'import sys',
        `_fast_markdown_inputs = ${JSON.stringify(inputValues)}`,
        'try:',
        '    sys.stdout.reconfigure(encoding=\'utf-8\')',
        '    sys.stderr.reconfigure(encoding=\'utf-8\')',
        'except Exception:',
        '    pass',
        'def _fast_markdown_input(prompt=\'\'):',
        '    if _fast_markdown_inputs:',
        '        return _fast_markdown_inputs.pop(0)',
        '    raise EOFError(\'FastMarkdown: 输入值不足，请补充 input() 的输入\')',
        'builtins.input = _fast_markdown_input',
        '',
        rawCode
    ].join('\n');
}

function appendChunkWithLimit(bufferState, chunk) {
    if (bufferState.bytes >= MAX_PYTHON_OUTPUT_BYTES) {
        bufferState.truncated = true;
        return;
    }

    const chunkText = chunk.toString('utf-8');
    const chunkBytes = Buffer.byteLength(chunkText);
    const remainingBytes = MAX_PYTHON_OUTPUT_BYTES - bufferState.bytes;

    if (chunkBytes <= remainingBytes) {
        bufferState.text += chunkText;
        bufferState.bytes += chunkBytes;
        return;
    }

    const truncatedBuffer = Buffer.from(chunkText, 'utf-8').subarray(0, remainingBytes);
    bufferState.text += truncatedBuffer.toString('utf-8');
    bufferState.bytes = MAX_PYTHON_OUTPUT_BYTES;
    bufferState.truncated = true;
}

function runPythonProcess(command, args) {
    return new Promise((resolve) => {
        let settled = false;
        let timedOut = false;

        const stdoutState = { text: '', bytes: 0, truncated: false };
        const stderrState = { text: '', bytes: 0, truncated: false };

        const pythonProcess = spawn(command, args, {
            windowsHide: true,
            env: {
                ...process.env,
                PYTHONIOENCODING: 'utf-8',
                PYTHONUTF8: '1'
            }
        });

        const timeout = setTimeout(() => {
            timedOut = true;
            pythonProcess.kill();
        }, PYTHON_TIMEOUT_MS);

        const finalize = (payload) => {
            if (settled) {
                return;
            }

            settled = true;
            clearTimeout(timeout);
            resolve(payload);
        };

        pythonProcess.stdout.on('data', (chunk) => {
            appendChunkWithLimit(stdoutState, chunk);
        });

        pythonProcess.stderr.on('data', (chunk) => {
            appendChunkWithLimit(stderrState, chunk);
        });

        pythonProcess.on('error', (err) => {
            finalize({
                success: false,
                output: '',
                error: err.message,
                exitCode: -1,
                spawnErrorCode: err.code || ''
            });
        });

        pythonProcess.on('close', (exitCode) => {
            let output = stdoutState.text;
            let error = stderrState.text;

            if (stdoutState.truncated) {
                output += '\n\n[输出已截断：超过 1MB 限制]';
            }
            if (stderrState.truncated) {
                error += '\n\n[错误输出已截断：超过 1MB 限制]';
            }
            if (timedOut) {
                error += (error ? '\n' : '') + '执行超时：已超过 30 秒限制。';
            }

            finalize({
                success: exitCode === 0 && !timedOut,
                output,
                error,
                exitCode: timedOut ? -1 : exitCode
            });
        });
    });
}

async function runPythonCode(code, parentWindow) {
    const inputResult = await collectPythonInputs(code, parentWindow);
    if (inputResult.cancelled) {
        return { success: false, output: '', error: '用户取消了输入', exitCode: -1 };
    }

    const script = buildPythonCode(code, inputResult.values);

    const primaryResult = await runPythonProcess('python', ['-c', script]);
    if (primaryResult.spawnErrorCode !== 'ENOENT') {
        return primaryResult;
    }

    const fallbackResult = await runPythonProcess('py', ['-3', '-c', script]);
    if (fallbackResult.spawnErrorCode === 'ENOENT') {
        return {
            success: false,
            output: '',
            error: '无法执行 Python: 未找到 python 或 py 命令。\n请确保已安装 Python 并添加到系统 PATH。',
            exitCode: -1
        };
    }

    return fallbackResult;
}

function showInputDialog(prompt, parentWindow) {
    return new Promise((resolve) => {
        const promptRequestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const promptWindow = new BrowserWindow({
            width: 420,
            height: 220,
            parent: parentWindow && !parentWindow.isDestroyed() ? parentWindow : undefined,
            modal: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            show: false,
            frame: false,
            webPreferences: {
                preload: path.join(__dirname, 'prompt-preload.js'),
                nodeIntegration: false,
                contextIsolation: true,
                sandbox: true,
                webSecurity: true
            }
        });

        setupNavigationGuards(promptWindow);

        const responseListener = (_event, payload) => {
            if (!payload || payload.requestId !== promptRequestId) {
                return;
            }

            ipcMain.removeListener('prompt-response', responseListener);

            if (!promptWindow.isDestroyed()) {
                promptWindow.close();
            }

            resolve({
                value: String(payload.value || ''),
                cancelled: Boolean(payload.cancelled)
            });
        };

        ipcMain.on('prompt-response', responseListener);

        promptWindow.on('closed', () => {
            ipcMain.removeListener('prompt-response', responseListener);
            resolve({ value: '', cancelled: true });
        });

        promptWindow.loadFile(getRendererPath('prompt.html')).then(() => {
            promptWindow.webContents.send('prompt-data', {
                requestId: promptRequestId,
                prompt: String(prompt || '请输入:')
            });
            promptWindow.show();
        }).catch(() => {
            if (!promptWindow.isDestroyed()) {
                promptWindow.close();
            }
        });
    });
}

function createMenu() {
    const sendToFocusedWindow = (channel, payload) => {
        const targetWindow = getPrimaryWindow();
        if (targetWindow && !targetWindow.isDestroyed()) {
            targetWindow.webContents.send(channel, payload);
        }
    };

    const template = [
        {
            label: '文件',
            submenu: [
                {
                    label: '新建',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => sendToFocusedWindow('menu-new-file')
                },
                {
                    label: '新建窗口',
                    accelerator: 'CmdOrCtrl+Shift+N',
                    click: () => createWindow()
                },
                {
                    label: '打开',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => {
                        const targetWindow = getPrimaryWindow();
                        if (targetWindow) {
                            openFileDialog(targetWindow);
                        } else {
                            createWindow();
                        }
                    }
                },
                {
                    label: '保存',
                    accelerator: 'CmdOrCtrl+S',
                    click: () => sendToFocusedWindow('menu-save')
                },
                {
                    label: '另存为',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: () => sendToFocusedWindow('menu-save-as')
                },
                {
                    label: '导出 PDF',
                    accelerator: 'CmdOrCtrl+Shift+E',
                    click: () => sendToFocusedWindow('menu-export-pdf')
                },
                { type: 'separator' },
                {
                    label: '退出',
                    accelerator: 'CmdOrCtrl+Q',
                    click: () => app.quit()
                }
            ]
        },
        {
            label: '编辑',
            submenu: [
                { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
                { label: '重做', accelerator: 'CmdOrCtrl+Y', role: 'redo' },
                { type: 'separator' },
                { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
                { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
                { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
                { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' }
            ]
        },
        {
            label: '视图',
            submenu: [
                {
                    label: '分屏视图',
                    accelerator: 'CmdOrCtrl+1',
                    click: () => sendToFocusedWindow('change-view', 'split')
                },
                {
                    label: '仅编辑器',
                    accelerator: 'CmdOrCtrl+2',
                    click: () => sendToFocusedWindow('change-view', 'editor')
                },
                {
                    label: '仅预览',
                    accelerator: 'CmdOrCtrl+3',
                    click: () => sendToFocusedWindow('change-view', 'preview')
                },
                { type: 'separator' },
                {
                    label: '切换主题',
                    accelerator: 'CmdOrCtrl+T',
                    click: () => sendToFocusedWindow('toggle-theme')
                },
                { type: 'separator' },
                { label: '开发者工具', accelerator: 'F12', role: 'toggleDevTools' }
            ]
        },
        {
            label: '帮助',
            submenu: [
                {
                    label: '检查更新',
                    click: () => {
                        checkForUpdates(true);
                    }
                },
                {
                    label: '下载更新',
                    click: () => {
                        downloadUpdate();
                    }
                },
                {
                    label: '安装更新并重启',
                    click: () => {
                        installDownloadedUpdate();
                    }
                },
                { type: 'separator' },
                {
                    label: '关于',
                    click: () => {
                        const targetWindow = getPrimaryWindow();
                        const options = {
                            type: 'info',
                            title: '关于 Fast Markdown',
                            message: APP_TITLE,
                            detail: `版本 ${app.getVersion()}\n一个支持运行 Python 代码的本地 Markdown 编辑器`
                        };

                        if (targetWindow) {
                            dialog.showMessageBox(targetWindow, options);
                        } else {
                            dialog.showMessageBox(options);
                        }
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

function registerIpcHandlers() {
    ipcMain.handle('open-file-dialog', async (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return openFileDialog(window);
    });

    ipcMain.handle('save-file', async (event, payload) => {
        try {
            const window = BrowserWindow.fromWebContents(event.sender);
            const state = getWindowState(window);
            const { content, filePath } = payload;
            let savePath = filePath || state?.filePath || null;

            if (!savePath) {
                const result = await dialog.showSaveDialog(window, {
                    filters: [{ name: 'Markdown Files', extensions: ['md'] }]
                });

                if (result.canceled || !result.filePath) {
                    return { success: false, cancelled: true };
                }

                savePath = result.filePath;
            }

            await fs.writeFile(savePath, content, 'utf-8');
            if (state) {
                state.filePath = savePath;
                state.isDocumentDirty = false;
            }
            setWindowTitle(window, savePath);
            return { success: true, path: savePath, name: path.basename(savePath) };
        } catch (err) {
            dialog.showErrorBox('保存文件失败', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('save-file-as', async (event, payload) => {
        try {
            const window = BrowserWindow.fromWebContents(event.sender);
            const state = getWindowState(window);
            const { content } = payload;
            const result = await dialog.showSaveDialog(window, {
                filters: [{ name: 'Markdown Files', extensions: ['md'] }]
            });

            if (result.canceled || !result.filePath) {
                return { success: false, cancelled: true };
            }

            await fs.writeFile(result.filePath, content, 'utf-8');
            if (state) {
                state.filePath = result.filePath;
                state.isDocumentDirty = false;
            }
            setWindowTitle(window, result.filePath);
            return { success: true, path: result.filePath, name: path.basename(result.filePath) };
        } catch (err) {
            dialog.showErrorBox('保存文件失败', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('export-pdf', async (event, payload) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return exportPdf(window, payload);
    });

    ipcMain.handle('run-python', async (event, code) => {
        if (typeof code !== 'string') {
            return { success: false, output: '', error: '代码格式无效', exitCode: -1 };
        }

        const window = BrowserWindow.fromWebContents(event.sender);
        return runPythonCode(code, window);
    });

    ipcMain.handle('get-current-file', (event) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        return getWindowState(window)?.filePath || null;
    });
    ipcMain.handle('check-for-updates', async (_event, payload) => {
        const manual = Boolean(payload && payload.manual);
        return checkForUpdates(manual);
    });
    ipcMain.handle('download-update', async () => downloadUpdate());
    ipcMain.handle('install-update', async () => installDownloadedUpdate());

    ipcMain.on('document-dirty-state', (event, dirty) => {
        const window = BrowserWindow.fromWebContents(event.sender);
        const state = getWindowState(window);
        if (state) {
            state.isDocumentDirty = Boolean(dirty);
        }
    });

    ipcMain.on('renderer-save-response', (_event, payload) => {
        const callback = pendingSaveRequests.get(payload?.requestId);
        if (!callback) {
            return;
        }

        pendingSaveRequests.delete(payload.requestId);
        callback(Boolean(payload.success));
    });
}

function createWindow(initialFilePath = null) {
    const window = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 800,
        minHeight: 600,
        icon: getAssetPath('assets', 'icon.png'),
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: false,
            webSecurity: true,
            allowRunningInsecureContent: false,
            webviewTag: false
        },
        frame: true,
        titleBarStyle: 'default',
        backgroundColor: '#1a1a2e'
    });

    mainWindow = window;
    getWindowState(window);
    setupNavigationGuards(window);
    setWindowTitle(window);

    window.on('focus', () => {
        mainWindow = window;
    });

    window.on('close', (event) => {
        const state = getWindowState(window);
        if (!state || state.forceClosing || !state.isDocumentDirty) {
            return;
        }

        event.preventDefault();

        if (state.closeInProgress) {
            return;
        }

        state.closeInProgress = true;
        ensureNoUnsavedChanges(window, 'close').then((canClose) => {
            if (canClose && !window.isDestroyed()) {
                state.forceClosing = true;
                window.close();
            }
        }).finally(() => {
            state.closeInProgress = false;
        });
    });

    window.on('closed', () => {
        windowStates.delete(window.id);
        if (mainWindow === window) {
            mainWindow = getPrimaryWindow();
        }
    });

    window.loadFile(getRendererPath('index.html'));

    window.webContents.once('did-finish-load', () => {
        if (updateReadyToInstall) {
            sendUpdaterStatus({
                type: 'downloaded',
                message: '更新已下载完成，可安装并重启。'
            }, window);
        }

        if (initialFilePath) {
            openFileInWindow(window, initialFilePath);
        }
    });

    createMenu();
    return window;
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, commandLine) => {
        const filePath = resolveMarkdownPathFromArgs(commandLine);
        if (filePath) {
            const reusableWindow = getReusableWindow();
            if (reusableWindow) {
                if (reusableWindow.isMinimized()) {
                    reusableWindow.restore();
                }
                reusableWindow.focus();
                openFileInWindow(reusableWindow, filePath);
            } else {
                const newWindow = createWindow(filePath);
                if (newWindow.isMinimized()) {
                    newWindow.restore();
                }
                newWindow.focus();
            }
            return;
        }

        const targetWindow = getPrimaryWindow();
        if (!targetWindow) {
            createWindow();
            return;
        }

        if (targetWindow.isMinimized()) {
            targetWindow.restore();
        }
        targetWindow.focus();
    });

    app.whenReady().then(() => {
        registerIpcHandlers();
        const startupFile = resolveMarkdownPathFromArgs(process.argv.slice(1)) || pendingMacOpenFiles.shift() || null;
        createWindow(startupFile);
        pendingMacOpenFiles.forEach((filePath) => {
            createWindow(filePath);
        });
        pendingMacOpenFiles = [];
        setupAutoUpdater();

        setTimeout(() => {
            checkForUpdates(false);
        }, AUTO_UPDATE_CHECK_DELAY_MS);

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createWindow();
            }
        });
    });
}

app.on('open-file', (event, filePath) => {
    event.preventDefault();

    const reusableWindow = getReusableWindow();
    if (reusableWindow) {
        openFileInWindow(reusableWindow, filePath);
        return;
    }

    if (app.isReady()) {
        createWindow(filePath);
        return;
    }

    pendingMacOpenFiles.push(filePath);
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
