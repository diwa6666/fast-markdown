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
    const { allowImageData = false } = options;

    if (!safeUrl) {
        return '';
    }

    if (safeUrl.startsWith('#')) {
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
    const safeHref = sanitizeLink(href, { allowImageData: true });
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

function renderMarkdown(markdown) {
    return marked.parse(String(markdown || ''));
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
    onChangeView: (callback) => listen('change-view', callback),
    onToggleTheme: (callback) => listen('toggle-theme', callback),
    onMainRequestSave: (callback) => listen('main-request-save', callback),
    onUpdaterStatus: (callback) => listen('updater-status', callback)
});
