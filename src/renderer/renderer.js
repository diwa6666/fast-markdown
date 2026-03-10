const PREVIEW_DEBOUNCE_MS = 120;

let currentFilePath = null;
let isModified = false;
let currentView = 'split';
let isDarkTheme = true;
let currentLineCount = 1;
let previewDebounceTimer = null;
let pendingMathTypeset = false;
let isMathTypesetting = false;

const ipcUnsubscribers = [];

const editor = document.getElementById('editor');
const preview = document.getElementById('preview');
const editorContainer = document.getElementById('editorContainer');
const lineNumbers = document.getElementById('lineNumbers');
const editorStats = document.getElementById('editorStats');
const currentFileName = document.getElementById('currentFileName');
const saveIndicator = document.getElementById('saveIndicator');
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebarToggle');
const resizer = document.getElementById('resizer');
const modalOverlay = document.getElementById('modalOverlay');
const pythonOutput = document.getElementById('pythonOutput');
const pythonError = document.getElementById('pythonError');
const errorSection = document.getElementById('errorSection');
const loadingOverlay = document.getElementById('loadingOverlay');
const loadingText = document.getElementById('loadingText');
const updateBanner = document.getElementById('updateBanner');
const updateBannerText = document.getElementById('updateBannerText');
const updateActionBtn = document.getElementById('updateActionBtn');
const updateDismissBtn = document.getElementById('updateDismissBtn');

const sunIcon = document.querySelector('.sun-icon');
const moonIcon = document.querySelector('.moon-icon');
let updateActionHandler = null;
let updateBannerTimer = null;

document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    updateLineNumbers(true);
    updateStats();
    updatePreview();
    loadTheme();
    setModified(false);
});

window.addEventListener('beforeunload', () => {
    ipcUnsubscribers.forEach((unsubscribe) => unsubscribe());
});

function setupEventListeners() {
    editor.addEventListener('input', handleEditorInput);
    editor.addEventListener('scroll', syncLineNumbers);
    editor.addEventListener('keydown', handleEditorKeydown);

    document.getElementById('newFileBtn').addEventListener('click', newFile);
    document.getElementById('openFileBtn').addEventListener('click', openFile);
    document.getElementById('saveBtn').addEventListener('click', saveFile);
    document.getElementById('exportPdfBtn').addEventListener('click', exportPdf);
    document.getElementById('themeToggle').addEventListener('click', toggleTheme);

    document.querySelectorAll('.view-btn').forEach((btn) => {
        btn.addEventListener('click', () => setView(btn.dataset.view));
    });

    sidebarToggle.addEventListener('click', toggleSidebar);
    setupResizer();

    document.getElementById('closeModal').addEventListener('click', closeModal);
    document.getElementById('closeModalBtn').addEventListener('click', closeModal);
    document.getElementById('copyOutput').addEventListener('click', copyOutput);
    updateDismissBtn.addEventListener('click', hideUpdateBanner);
    updateActionBtn.addEventListener('click', () => {
        if (typeof updateActionHandler === 'function') {
            updateActionHandler();
        }
    });

    modalOverlay.addEventListener('click', (event) => {
        if (event.target === modalOverlay) {
            closeModal();
        }
    });

    if (window.electronAPI) {
        ipcUnsubscribers.push(window.electronAPI.onFileOpened(handleFileOpened));
        ipcUnsubscribers.push(window.electronAPI.onMenuNewFile(newFile));
        ipcUnsubscribers.push(window.electronAPI.onMenuSave(saveFile));
        ipcUnsubscribers.push(window.electronAPI.onMenuSaveAs(saveFileAs));
        ipcUnsubscribers.push(window.electronAPI.onMenuExportPdf(exportPdf));
        ipcUnsubscribers.push(window.electronAPI.onChangeView(setView));
        ipcUnsubscribers.push(window.electronAPI.onToggleTheme(toggleTheme));
        ipcUnsubscribers.push(window.electronAPI.onMainRequestSave(handleMainSaveRequest));
        ipcUnsubscribers.push(window.electronAPI.onUpdaterStatus(handleUpdaterStatus));
    }

    document.addEventListener('keydown', handleGlobalKeydown);
}

function handleEditorInput() {
    setModified(true);
    updateLineNumbers();
    updateStats();
    schedulePreviewUpdate();
}

function handleEditorKeydown(event) {
    if (event.key !== 'Tab') {
        return;
    }

    event.preventDefault();
    const start = editor.selectionStart;
    const end = editor.selectionEnd;
    editor.value = `${editor.value.slice(0, start)}    ${editor.value.slice(end)}`;
    editor.selectionStart = start + 4;
    editor.selectionEnd = start + 4;
    handleEditorInput();
}

function handleGlobalKeydown(event) {
    const isCmdOrCtrl = event.ctrlKey || event.metaKey;
    if (!isCmdOrCtrl) {
        if (event.key === 'Escape') {
            closeModal();
        }
        return;
    }

    const lowerKey = event.key.toLowerCase();
    if (lowerKey === 's' && event.shiftKey) {
        event.preventDefault();
        saveFileAs();
        return;
    }

    if (lowerKey === 's') {
        event.preventDefault();
        saveFile();
        return;
    }

    if (lowerKey === 'e' && event.shiftKey) {
        event.preventDefault();
        exportPdf();
    }
}

function updateLineNumbers(force = false) {
    const lineCount = editor.value.split('\n').length;

    if (!force && lineCount === currentLineCount) {
        return;
    }

    currentLineCount = lineCount;
    const html = Array.from({ length: lineCount }, (_, index) => `<div class="line-number">${index + 1}</div>`).join('');
    lineNumbers.innerHTML = html;
}

function syncLineNumbers() {
    lineNumbers.scrollTop = editor.scrollTop;
}

function updateStats() {
    const text = editor.value;
    const chars = text.length;
    const lines = text.split('\n').length;
    editorStats.textContent = `${chars} 字符 | ${lines} 行`;
}

function schedulePreviewUpdate() {
    clearTimeout(previewDebounceTimer);
    previewDebounceTimer = setTimeout(updatePreview, PREVIEW_DEBOUNCE_MS);
}

function updatePreview() {
    const markdown = editor.value;

    if (!markdown.trim()) {
        preview.innerHTML = [
            '<div class="empty-preview">',
            '<div class="empty-icon">📄</div>',
            '<p>开始输入以查看预览</p>',
            '</div>'
        ].join('');
        return;
    }

    const renderedHtml = window.electronAPI
        ? window.electronAPI.renderMarkdown(markdown)
        : escapeHtml(markdown).replace(/\n/g, '<br>');

    const sanitizedHtml = sanitizeRenderedHtml(renderedHtml);
    const wrappedHtml = wrapPythonCodeBlocks(sanitizedHtml);

    preview.innerHTML = wrappedHtml;

    preview.querySelectorAll('.run-python-btn').forEach((button) => {
        button.addEventListener('click', () => {
            runPythonCode(button.dataset.code || '');
        });
    });

    requestMathTypeset();
}

function requestMathTypeset() {
    if (!window.MathJax) {
        return;
    }

    pendingMathTypeset = true;
    flushMathTypesetQueue();
}

function flushMathTypesetQueue() {
    if (!pendingMathTypeset || isMathTypesetting || !window.MathJax) {
        return;
    }

    const mathJax = window.MathJax;
    if (!mathJax.startup || !mathJax.startup.promise || typeof mathJax.typesetPromise !== 'function') {
        return;
    }

    pendingMathTypeset = false;
    isMathTypesetting = true;

    mathJax.startup.promise
        .then(() => {
            if (typeof mathJax.typesetClear === 'function') {
                mathJax.typesetClear([preview]);
            }

            return mathJax.typesetPromise([preview]);
        })
        .catch((error) => {
            console.error('MathJax 渲染失败:', error);
        })
        .finally(() => {
            isMathTypesetting = false;
            if (pendingMathTypeset) {
                flushMathTypesetQueue();
            }
        });
}

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sanitizeUrl(url, options = {}) {
    const value = String(url || '').trim();
    if (!value) {
        return '';
    }

    const { allowImageData = false } = options;

    if (value.startsWith('#')) {
        return value;
    }

    const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value);
    if (!hasScheme) {
        return value;
    }

    const lower = value.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')) {
        return value;
    }

    if (allowImageData && lower.startsWith('data:image/')) {
        return value;
    }

    return '';
}

function sanitizeRenderedHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = html;

    const blockedTags = ['script', 'style', 'iframe', 'object', 'embed', 'meta', 'link'];
    blockedTags.forEach((tagName) => {
        template.content.querySelectorAll(tagName).forEach((node) => node.remove());
    });

    template.content.querySelectorAll('*').forEach((element) => {
        const attributes = [...element.attributes];

        attributes.forEach((attribute) => {
            const attrName = attribute.name.toLowerCase();
            const attrValue = attribute.value;

            if (attrName.startsWith('on')) {
                element.removeAttribute(attribute.name);
                return;
            }

            if (attrName === 'style') {
                element.removeAttribute(attribute.name);
                return;
            }

            if (attrName === 'href') {
                const safeHref = sanitizeUrl(attrValue);
                if (!safeHref) {
                    element.removeAttribute(attribute.name);
                } else {
                    element.setAttribute('href', safeHref);
                }
                return;
            }

            if (attrName === 'src') {
                const safeSrc = sanitizeUrl(attrValue, { allowImageData: true });
                if (!safeSrc) {
                    element.removeAttribute(attribute.name);
                } else {
                    element.setAttribute('src', safeSrc);
                }
            }
        });

        if (element.tagName.toLowerCase() === 'a' && element.hasAttribute('href')) {
            element.setAttribute('target', '_blank');
            element.setAttribute('rel', 'noopener noreferrer');
        }
    });

    return template.innerHTML;
}

function wrapPythonCodeBlocks(html) {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;

    tempDiv.querySelectorAll('pre').forEach((preElement) => {
        const codeElement = preElement.querySelector('code');
        const isPythonCode = codeElement && (
            codeElement.classList.contains('language-python') ||
            codeElement.classList.contains('language-py')
        );

        if (!isPythonCode) {
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.className = 'code-block-wrapper';

        const header = document.createElement('div');
        header.className = 'code-block-header';

        const languageLabel = document.createElement('span');
        languageLabel.className = 'code-language';
        const languageIcon = document.createElement('span');
        languageIcon.className = 'code-language-icon';
        languageIcon.textContent = '🐍';
        languageLabel.appendChild(languageIcon);
        languageLabel.appendChild(document.createTextNode(' Python'));

        const runButton = document.createElement('button');
        runButton.type = 'button';
        runButton.className = 'run-python-btn';
        runButton.dataset.code = codeElement.textContent || '';

        const playIcon = document.createElement('span');
        playIcon.className = 'play-icon';
        playIcon.textContent = '▶';

        runButton.appendChild(playIcon);
        runButton.appendChild(document.createTextNode(' 运行'));

        header.appendChild(languageLabel);
        header.appendChild(runButton);

        preElement.parentNode.insertBefore(wrapper, preElement);
        wrapper.appendChild(header);
        wrapper.appendChild(preElement);
    });

    return tempDiv.innerHTML;
}

async function runPythonCode(code) {
    if (!window.electronAPI) {
        showModal('', '无法在浏览器中运行 Python，请使用 Electron 应用');
        return;
    }

    showLoading(true, '正在执行 Python 代码...');

    try {
        const result = await window.electronAPI.runPython(code);
        showLoading(false);

        if (result.success) {
            showModal(result.output || '(无输出)', '');
        } else {
            showModal(result.output || '', result.error || '执行失败');
        }
    } catch (error) {
        showLoading(false);
        showModal('', `执行错误: ${error.message}`);
    }
}

function showModal(output, error) {
    pythonOutput.textContent = output || '(无输出)';

    if (error) {
        errorSection.classList.remove('is-hidden');
        pythonError.textContent = error;
    } else {
        errorSection.classList.add('is-hidden');
        pythonError.textContent = '';
    }

    modalOverlay.classList.add('active');
}

function closeModal() {
    modalOverlay.classList.remove('active');
}

function copyOutput() {
    const text = pythonOutput.textContent;
    navigator.clipboard.writeText(text).then(() => {
        const button = document.getElementById('copyOutput');
        const previousText = button.textContent;
        button.textContent = '✓ 已复制';

        setTimeout(() => {
            button.textContent = previousText;
        }, 2000);
    });
}

function showLoading(show, message = '正在执行 Python 代码...') {
    if (loadingText) {
        loadingText.textContent = message;
    }

    loadingOverlay.classList.toggle('active', show);
}

function showUpdateBanner(message, options = {}) {
    clearTimeout(updateBannerTimer);

    updateBannerText.textContent = message;
    updateBanner.classList.remove('is-hidden');

    const { actionText = '', action = null, autoHideMs = 0 } = options;

    updateActionHandler = action;
    if (action && actionText) {
        updateActionBtn.textContent = actionText;
        updateActionBtn.classList.remove('is-hidden');
    } else {
        updateActionBtn.classList.add('is-hidden');
    }

    if (autoHideMs > 0) {
        updateBannerTimer = setTimeout(() => {
            hideUpdateBanner();
        }, autoHideMs);
    }
}

function hideUpdateBanner() {
    clearTimeout(updateBannerTimer);
    updateActionHandler = null;
    updateActionBtn.classList.add('is-hidden');
    updateBanner.classList.add('is-hidden');
}

async function handleUpdaterStatus(status) {
    if (!status || !status.type) {
        return;
    }

    switch (status.type) {
        case 'checking':
            showUpdateBanner('正在检查更新...');
            break;
        case 'available':
            showUpdateBanner(
                `发现新版本 ${status.version || ''}，可以开始下载。`.trim(),
                {
                    actionText: '下载更新',
                    action: () => {
                        if (window.electronAPI) {
                            window.electronAPI.downloadUpdate();
                        }
                    }
                }
            );
            break;
        case 'downloading':
            showUpdateBanner(`正在下载更新：${Math.round(status.percent || 0)}%`);
            break;
        case 'downloaded':
            showUpdateBanner(
                `更新已下载${status.version ? `（${status.version}）` : ''}，重启后即可完成安装。`,
                {
                    actionText: '安装并重启',
                    action: () => {
                        if (window.electronAPI) {
                            window.electronAPI.installUpdate();
                        }
                    }
                }
            );
            break;
        case 'not-available':
            showUpdateBanner('当前已是最新版本。', { autoHideMs: 3000 });
            break;
        case 'busy':
        case 'not-ready':
        case 'disabled':
            showUpdateBanner(status.message || '更新功能当前不可用。', { autoHideMs: 5000 });
            break;
        case 'error':
            showUpdateBanner(`更新失败：${status.message || '未知错误'}`, { autoHideMs: 6000 });
            break;
        default:
            break;
    }
}

function newFile() {
    if (isModified && !window.confirm('当前文件未保存，确定要新建文件吗？')) {
        return;
    }

    editor.value = '';
    currentFilePath = null;
    currentFileName.textContent = '未命名文档';

    setModified(false);
    updateLineNumbers(true);
    updateStats();
    updatePreview();
}

async function openFile() {
    if (window.electronAPI) {
        await window.electronAPI.openFileDialog();
    }
}

function handleFileOpened(data) {
    editor.value = data.content;
    currentFilePath = data.path;
    currentFileName.textContent = data.name;

    setModified(false);
    updateLineNumbers(true);
    updateStats();
    updatePreview();
}

async function saveFile() {
    if (!window.electronAPI) {
        return { success: false };
    }

    const result = await window.electronAPI.saveFile({
        content: editor.value,
        filePath: currentFilePath
    });

    if (result.success) {
        currentFilePath = result.path;
        currentFileName.textContent = result.name;
        setModified(false);
        showSaveNotification();
    }

    return result;
}

async function saveFileAs() {
    if (!window.electronAPI) {
        return { success: false };
    }

    const result = await window.electronAPI.saveFileAs({
        content: editor.value
    });

    if (result.success) {
        currentFilePath = result.path;
        currentFileName.textContent = result.name;
        setModified(false);
        showSaveNotification();
    }

    return result;
}

async function ensureMathTypesetForExport() {
    if (!window.MathJax) {
        return;
    }

    const mathJax = window.MathJax;
    if (!mathJax.startup || !mathJax.startup.promise || typeof mathJax.typesetPromise !== 'function') {
        return;
    }

    await mathJax.startup.promise.catch(() => undefined);

    if (typeof mathJax.typesetClear === 'function') {
        mathJax.typesetClear([preview]);
    }

    await mathJax.typesetPromise([preview]).catch((error) => {
        console.error('导出前 MathJax 渲染失败:', error);
    });
}

window.preparePdfExport = async () => {
    await ensureMathTypesetForExport();
    return true;
};

async function exportPdf() {
    if (!window.electronAPI) {
        return { success: false };
    }

    showLoading(true, '正在导出 PDF...');

    try {
        await ensureMathTypesetForExport();

        const result = await window.electronAPI.exportPdf({
            suggestedName: currentFileName.textContent || '未命名文档'
        });

        showLoading(false);

        if (result.success) {
            showUpdateBanner(`PDF 导出成功：${result.name}`, { autoHideMs: 4000 });
        } else if (!result.cancelled) {
            showUpdateBanner(`PDF 导出失败：${result.error || '未知错误'}`, { autoHideMs: 5000 });
        }

        return result;
    } catch (error) {
        showLoading(false);
        showUpdateBanner(`PDF 导出失败：${error.message}`, { autoHideMs: 5000 });
        return { success: false, error: error.message };
    }
}

function setModified(modified) {
    isModified = modified;
    saveIndicator.classList.toggle('unsaved', modified);
    saveIndicator.classList.remove('saved-flash');

    if (window.electronAPI) {
        window.electronAPI.setDocumentDirty(modified);
    }
}

function showSaveNotification() {
    saveIndicator.classList.remove('unsaved');
    saveIndicator.classList.add('saved-flash');

    setTimeout(() => {
        saveIndicator.classList.remove('saved-flash');
    }, 2000);
}

async function handleMainSaveRequest(payload) {
    const result = await saveFile();

    if (window.electronAPI) {
        window.electronAPI.sendMainSaveResponse({
            requestId: payload.requestId,
            success: Boolean(result && result.success)
        });
    }
}

function setView(view) {
    currentView = view;
    editorContainer.className = `editor-container ${view}`;

    document.querySelectorAll('.view-btn').forEach((button) => {
        button.classList.toggle('active', button.dataset.view === view);
    });
}

function toggleSidebar() {
    sidebar.classList.toggle('collapsed');
}

function toggleTheme() {
    isDarkTheme = !isDarkTheme;
    applyTheme();
    saveTheme();
}

function applyTheme() {
    if (isDarkTheme) {
        document.body.removeAttribute('data-theme');
    } else {
        document.body.setAttribute('data-theme', 'light');
    }

    sunIcon.classList.toggle('is-hidden', !isDarkTheme);
    moonIcon.classList.toggle('is-hidden', isDarkTheme);
}

function loadTheme() {
    const savedTheme = localStorage.getItem('theme');
    isDarkTheme = savedTheme !== 'light';
    applyTheme();
}

function saveTheme() {
    localStorage.setItem('theme', isDarkTheme ? 'dark' : 'light');
}

function setupResizer() {
    let isResizing = false;

    resizer.addEventListener('mousedown', () => {
        isResizing = true;
        resizer.classList.add('dragging');
        document.body.style.cursor = 'col-resize';
        document.body.style.userSelect = 'none';
    });

    document.addEventListener('mousemove', (event) => {
        if (!isResizing) {
            return;
        }

        const containerRect = editorContainer.getBoundingClientRect();
        const editorPane = document.getElementById('editorPane');
        const previewPane = document.getElementById('previewPane');

        let newWidth = event.clientX - containerRect.left;
        const minWidth = 300;
        const maxWidth = containerRect.width - minWidth - 6;

        newWidth = Math.max(minWidth, Math.min(newWidth, maxWidth));

        const percentage = (newWidth / containerRect.width) * 100;
        editorPane.style.width = `${percentage}%`;
        previewPane.style.width = `${100 - percentage}%`;
    });

    document.addEventListener('mouseup', () => {
        if (!isResizing) {
            return;
        }

        isResizing = false;
        resizer.classList.remove('dragging');
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    });
}
