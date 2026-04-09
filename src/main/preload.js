const path = require('path');
const { pathToFileURL } = require('url');
const { contextBridge, ipcRenderer } = require('electron');
const { marked } = require('marked');
const hljs = require('highlight.js');

function escapeHtml(text) {
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sanitizeLink(url, options = {}) {
    const safeUrl = String(url || '').trim();
    const { allowImageData = false, allowFile = false } = options;

    if (!safeUrl) {
        return '';
    }

    if (safeUrl.startsWith('#')) {
        return safeUrl;
    }

    if (allowFile && isLocalFileReference(safeUrl)) {
        return safeUrl;
    }

    const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(safeUrl);
    if (!hasScheme) {
        return safeUrl;
    }

    const lowerSafeUrl = safeUrl.toLowerCase();
    if (lowerSafeUrl.startsWith('http://') || lowerSafeUrl.startsWith('https://') || lowerSafeUrl.startsWith('mailto:')) {
        return safeUrl;
    }

    if (allowImageData && lowerSafeUrl.startsWith('data:image/')) {
        return safeUrl;
    }

    return '';
}

function isWindowsAbsolutePath(value) {
    return /^[a-zA-Z]:[\\/]/.test(value);
}

function isUncPath(value) {
    return /^\\\\[^\\]/.test(value);
}

function isPosixAbsolutePath(value) {
    return value.startsWith('/');
}

function isLocalFileReference(value) {
    return value.toLowerCase().startsWith('file://')
        || isWindowsAbsolutePath(value)
        || isUncPath(value)
        || isPosixAbsolutePath(value);
}

function resolveMarkdownImageSource(href, baseFilePath) {
    const safeHref = sanitizeLink(href, { allowImageData: true, allowFile: true });
    if (!safeHref) {
        return '';
    }

    const lowerSafeHref = safeHref.toLowerCase();
    if (lowerSafeHref.startsWith('data:image/') || lowerSafeHref.startsWith('http://') || lowerSafeHref.startsWith('https://')) {
        return safeHref;
    }

    if (lowerSafeHref.startsWith('file://')) {
        try {
            return new URL(safeHref).toString();
        } catch {
            return '';
        }
    }

    try {
        if (isWindowsAbsolutePath(safeHref) || isUncPath(safeHref) || isPosixAbsolutePath(safeHref)) {
            return pathToFileURL(path.normalize(safeHref)).toString();
        }

        if (!baseFilePath) {
            return safeHref;
        }

        return pathToFileURL(path.resolve(path.dirname(baseFilePath), safeHref)).toString();
    } catch {
        return '';
    }
}

const markdownRenderContext = {
    filePath: null
};

const markdownRenderer = new marked.Renderer();

markdownRenderer.code = function (code, lang) {
    const codeText = code || '';
    const language = (lang || '').trim().toLowerCase();
    const validLanguage = language && hljs.getLanguage(language);

    let highlighted;
    if (validLanguage) {
        try {
            highlighted = hljs.highlight(codeText, { language }).value;
        } catch {
            highlighted = escapeHtml(codeText);
        }
    } else {
        highlighted = escapeHtml(codeText);
    }

    const langClass = language ? `language-${escapeHtml(language)}` : '';
    return `<pre><code class="hljs ${langClass}">${highlighted}</code></pre>`;
};

markdownRenderer.html = function () {
    // 禁用原始 HTML，避免脚本注入。
    return '';
};

markdownRenderer.link = function (href, title, text) {
    const safeHref = sanitizeLink(href);

    if (!safeHref) {
        return text || '';
    }

    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<a href="${escapeHtml(safeHref)}"${titleAttr} target="_blank" rel="noopener noreferrer">${text || ''}</a>`;
};

markdownRenderer.image = function (href, title, text) {
    const safeHref = resolveMarkdownImageSource(href, markdownRenderContext.filePath);
    if (!safeHref) {
        return '';
    }

    const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
    return `<img src="${escapeHtml(safeHref)}" alt="${escapeHtml(text || '')}"${titleAttr}>`;
};

marked.setOptions({
    renderer: markdownRenderer,
    gfm: true,
    breaks: true,
    mangle: false,
    headerIds: false
});

function renderMarkdown(markdown, options = {}) {
    markdownRenderContext.filePath = options?.filePath || null;

    try {
        return marked.parse(String(markdown || ''));
    } finally {
        markdownRenderContext.filePath = null;
    }
}

function listen(channel, callback) {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, listener);

    return () => {
        ipcRenderer.removeListener(channel, listener);
    };
}

contextBridge.exposeInMainWorld('electronAPI', {
    openFileDialog: () => ipcRenderer.invoke('open-file-dialog'),
    saveFile: (data) => ipcRenderer.invoke('save-file', data),
    saveFileAs: (data) => ipcRenderer.invoke('save-file-as', data),
    exportPdf: (data) => ipcRenderer.invoke('export-pdf', data),
    getCurrentFile: () => ipcRenderer.invoke('get-current-file'),
    runPython: (code) => ipcRenderer.invoke('run-python', code),
    checkForUpdates: (manual = false) => ipcRenderer.invoke('check-for-updates', { manual: Boolean(manual) }),
    downloadUpdate: () => ipcRenderer.invoke('download-update'),
    installUpdate: () => ipcRenderer.invoke('install-update'),
    renderMarkdown,

    setDocumentDirty: (dirty) => ipcRenderer.send('document-dirty-state', Boolean(dirty)),
    sendMainSaveResponse: (payload) => ipcRenderer.send('renderer-save-response', payload),

    onFileOpened: (callback) => listen('file-opened', callback),
    onMenuNewFile: (callback) => listen('menu-new-file', callback),
    onMenuSave: (callback) => listen('menu-save', callback),
    onMenuSaveAs: (callback) => listen('menu-save-as', callback),
    onMenuExportPdf: (callback) => listen('menu-export-pdf', callback),
    onChangeView: (callback) => listen('change-view', callback),
    onToggleTheme: (callback) => listen('toggle-theme', callback),
    onMainRequestSave: (callback) => listen('main-request-save', callback),
    onUpdaterStatus: (callback) => listen('updater-status', callback)
});
