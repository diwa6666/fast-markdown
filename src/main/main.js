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
let currentFilePath = null;
let isDocumentDirty = false;
let forceClosing = false;
let closeInProgress = false;
let pendingMacOpenFile = null;
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

function sendUpdaterStatus(payload) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    mainWindow.webContents.send(UPDATE_CHANNEL, payload);
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

    const canClose = await ensureNoUnsavedChanges('close');
    if (!canClose) {
        return { success: false, cancelled: true };
    }

    forceClosing = true;
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

function setWindowTitle(filePath = null) {
    if (!mainWindow || mainWindow.isDestroyed()) {
        return;
    }

    if (!filePath) {
        mainWindow.setTitle(APP_TITLE);
        return;
    }

    mainWindow.setTitle(`${APP_TITLE} - ${path.basename(filePath)}`);
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

async function requestRendererSave() {
    if (!mainWindow || mainWindow.isDestroyed()) {
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

        mainWindow.webContents.send('main-request-save', { requestId });
    });
}

async function ensureNoUnsavedChanges(action) {
    if (!isDocumentDirty) {
        return true;
    }

    const details = action === 'close'
        ? '当前文档有未保存更改。是否先保存再退出？'
        : '当前文档有未保存更改。是否先保存再继续？';

    const choice = dialog.showMessageBoxSync(mainWindow, {
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
        return requestRendererSave();
    }

    return choice === 1;
}

async function openFile(filePath) {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        currentFilePath = filePath;
        isDocumentDirty = false;

        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('file-opened', {
                path: filePath,
                name: path.basename(filePath),
                content
            });
            setWindowTitle(filePath);
        }

        return { success: true };
    } catch (err) {
        dialog.showErrorBox('打开文件失败', err.message);
        return { success: false, error: err.message };
    }
}

async function openFileWithGuard(filePath, skipDirtyCheck = false) {
    if (!filePath || !fsSync.existsSync(filePath)) {
        return { success: false, error: '文件不存在' };
    }

    if (!skipDirtyCheck) {
        const canProceed = await ensureNoUnsavedChanges('open');
        if (!canProceed) {
            return { success: false, cancelled: true };
        }
    }

    return openFile(filePath);
}

async function openFileDialog() {
    const canProceed = await ensureNoUnsavedChanges('open');
    if (!canProceed) {
        return { success: false, cancelled: true };
    }

    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openFile'],
        filters: [
            { name: 'Markdown Files', extensions: ['md', 'markdown'] },
            { name: 'All Files', extensions: ['*'] }
        ]
    });

    if (result.canceled || result.filePaths.length === 0) {
        return { success: false, cancelled: true };
    }

    return openFile(result.filePaths[0]);
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

async function collectPythonInputs(code) {
    const prompts = parseInputPrompts(code);
    if (prompts.length === 0) {
        return { cancelled: false, values: [] };
    }

    const values = [];
    for (const prompt of prompts) {
        const response = await showInputDialog(prompt);
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

async function runPythonCode(code) {
    const inputResult = await collectPythonInputs(code);
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

function showInputDialog(prompt) {
    return new Promise((resolve) => {
        const promptRequestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

        const promptWindow = new BrowserWindow({
            width: 420,
            height: 220,
            parent: mainWindow,
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
    const template = [
        {
            label: '文件',
            submenu: [
                {
                    label: '新建',
                    accelerator: 'CmdOrCtrl+N',
                    click: () => mainWindow.webContents.send('menu-new-file')
                },
                {
                    label: '打开',
                    accelerator: 'CmdOrCtrl+O',
                    click: () => openFileDialog()
                },
                {
                    label: '保存',
                    accelerator: 'CmdOrCtrl+S',
                    click: () => mainWindow.webContents.send('menu-save')
                },
                {
                    label: '另存为',
                    accelerator: 'CmdOrCtrl+Shift+S',
                    click: () => mainWindow.webContents.send('menu-save-as')
                },
                { type: 'separator' },
                {
                    label: '退出',
                    accelerator: 'CmdOrCtrl+Q',
                    click: async () => {
                        const canClose = await ensureNoUnsavedChanges('close');
                        if (canClose) {
                            forceClosing = true;
                            app.quit();
                        }
                    }
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
                    click: () => mainWindow.webContents.send('change-view', 'split')
                },
                {
                    label: '仅编辑器',
                    accelerator: 'CmdOrCtrl+2',
                    click: () => mainWindow.webContents.send('change-view', 'editor')
                },
                {
                    label: '仅预览',
                    accelerator: 'CmdOrCtrl+3',
                    click: () => mainWindow.webContents.send('change-view', 'preview')
                },
                { type: 'separator' },
                {
                    label: '切换主题',
                    accelerator: 'CmdOrCtrl+T',
                    click: () => mainWindow.webContents.send('toggle-theme')
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
                        dialog.showMessageBox(mainWindow, {
                            type: 'info',
                            title: '关于 Fast Markdown',
                            message: APP_TITLE,
                            detail: `版本 ${app.getVersion()}\n一个支持运行 Python 代码的本地 Markdown 编辑器`
                        });
                    }
                }
            ]
        }
    ];

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);
}

function registerIpcHandlers() {
    ipcMain.handle('open-file-dialog', async () => openFileDialog());

    ipcMain.handle('save-file', async (_event, payload) => {
        try {
            const { content, filePath } = payload;
            let savePath = filePath || currentFilePath;

            if (!savePath) {
                const result = await dialog.showSaveDialog(mainWindow, {
                    filters: [{ name: 'Markdown Files', extensions: ['md'] }]
                });

                if (result.canceled || !result.filePath) {
                    return { success: false, cancelled: true };
                }

                savePath = result.filePath;
            }

            await fs.writeFile(savePath, content, 'utf-8');
            currentFilePath = savePath;
            isDocumentDirty = false;
            setWindowTitle(savePath);
            return { success: true, path: savePath, name: path.basename(savePath) };
        } catch (err) {
            dialog.showErrorBox('保存文件失败', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('save-file-as', async (_event, payload) => {
        try {
            const { content } = payload;
            const result = await dialog.showSaveDialog(mainWindow, {
                filters: [{ name: 'Markdown Files', extensions: ['md'] }]
            });

            if (result.canceled || !result.filePath) {
                return { success: false, cancelled: true };
            }

            await fs.writeFile(result.filePath, content, 'utf-8');
            currentFilePath = result.filePath;
            isDocumentDirty = false;
            setWindowTitle(result.filePath);
            return { success: true, path: result.filePath, name: path.basename(result.filePath) };
        } catch (err) {
            dialog.showErrorBox('保存文件失败', err.message);
            return { success: false, error: err.message };
        }
    });

    ipcMain.handle('run-python', async (_event, code) => {
        if (typeof code !== 'string') {
            return { success: false, output: '', error: '代码格式无效', exitCode: -1 };
        }

        return runPythonCode(code);
    });

    ipcMain.handle('get-current-file', () => currentFilePath);
    ipcMain.handle('check-for-updates', async (_event, payload) => {
        const manual = Boolean(payload && payload.manual);
        return checkForUpdates(manual);
    });
    ipcMain.handle('download-update', async () => downloadUpdate());
    ipcMain.handle('install-update', async () => installDownloadedUpdate());

    ipcMain.on('document-dirty-state', (_event, dirty) => {
        isDocumentDirty = Boolean(dirty);
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

function createWindow() {
    mainWindow = new BrowserWindow({
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

    setupNavigationGuards(mainWindow);
    setWindowTitle();

    mainWindow.on('close', (event) => {
        if (forceClosing || !isDocumentDirty) {
            return;
        }

        event.preventDefault();

        if (closeInProgress) {
            return;
        }

        closeInProgress = true;
        ensureNoUnsavedChanges('close').then((canClose) => {
            if (canClose && mainWindow && !mainWindow.isDestroyed()) {
                forceClosing = true;
                mainWindow.close();
            }
        }).finally(() => {
            closeInProgress = false;
        });
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    mainWindow.loadFile(getRendererPath('index.html'));

    mainWindow.webContents.once('did-finish-load', () => {
        if (updateReadyToInstall) {
            sendUpdaterStatus({
                type: 'downloaded',
                message: '更新已下载完成，可安装并重启。'
            });
        }
    });

    const startupFile = resolveMarkdownPathFromArgs(process.argv.slice(1));
    if (startupFile) {
        mainWindow.webContents.once('did-finish-load', () => {
            openFileWithGuard(startupFile, true);
        });
    }

    if (pendingMacOpenFile) {
        mainWindow.webContents.once('did-finish-load', () => {
            openFileWithGuard(pendingMacOpenFile, true);
            pendingMacOpenFile = null;
        });
    }

    createMenu();
}

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', (_event, commandLine) => {
        if (!mainWindow) {
            return;
        }

        if (mainWindow.isMinimized()) {
            mainWindow.restore();
        }
        mainWindow.focus();

        const filePath = resolveMarkdownPathFromArgs(commandLine);
        if (filePath) {
            openFileWithGuard(filePath);
        }
    });

    app.whenReady().then(() => {
        registerIpcHandlers();
        createWindow();
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

    if (mainWindow) {
        openFileWithGuard(filePath);
        return;
    }

    pendingMacOpenFile = filePath;
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});
