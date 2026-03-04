# Fast Markdown

一个支持运行 Python 代码的本地 Markdown 编辑器（Electron）。

## 功能特点

- 📝 实时 Markdown 预览（含代码高亮）
- 🐍 Python 代码块一键运行（支持 `input()` 弹窗输入）
- 🌓 深色/浅色主题切换
- 📂 打开与保存 `.md/.markdown` 文件
- 💾 未保存状态提示与关闭/打开前保护
- 📊 字符/行数统计
- 🔄 内置自动更新（支持检查、下载、安装并重启）

## 目录结构

```text
fast-markdown/
├─ src/
│  ├─ main/        # Electron 主进程与 preload
│  └─ renderer/    # 界面、样式、渲染逻辑
├─ assets/         # 图标等静态资源
├─ scripts/        # 构建辅助脚本
├─ update-config.example.json # 自动更新配置模板
├─ package.json
├─ LICENSE
└─ README.md
```

## 安装和运行

### 开发模式

```bash
npm install
npm start
```

### 代码检查（语法）

```bash
npm run check
```

### 打包发布（Windows）

```bash
npm run build:win
```

## 自动更新配置

1. 首次配置时复制模板：

```bash
cp update-config.example.json update-config.json
```

2. 编辑根目录 `update-config.json`：

```json
{
    "enabled": true,
    "provider": "generic",
    "url": "https://your-domain.com/fast-markdown-updates/",
    "channel": "latest",
    "autoDownload": false
}
```

3. 运行 `npm run build:win` 重新打包。
4. 将 `latest.yml`、安装包和 `.blockmap` 上传到 `url` 指向的目录。
5. 客户端可在菜单“帮助 -> 检查更新”手动检查，或启动后自动检查。

> 开发模式（`npm start`）下不会执行自动更新。

## 开源发布建议

- 需要上传：`src/`、`assets/`、`package.json`、`package-lock.json`、`README.md`、`LICENSE`、`.gitignore`、`.editorconfig`、`update-config.example.json`
- 不要上传：`node_modules/`、`dist/`、`update-config.json`
- Windows 安装包请发布到 GitHub Releases，而不是直接提交到仓库

## 使用说明

在 Markdown 中使用 Python 代码块：

```python
print("Hello, World!")
for i in range(5):
    print(f"数字: {i}")
```

预览区会显示“运行”按钮，点击即可执行。

## 快捷键

- `Ctrl+N`：新建文件
- `Ctrl+O`：打开文件
- `Ctrl+S`：保存文件
- `Ctrl+Shift+S`：另存为
- `Ctrl+1`：分屏视图
- `Ctrl+2`：仅编辑器
- `Ctrl+3`：仅预览
- `Ctrl+T`：切换主题

## 安全说明

- 渲染进程已关闭 Node 集成，并启用上下文隔离。
- Markdown 原始 HTML 默认禁用，链接与资源地址会被过滤。
- 外部链接会在系统浏览器中打开，不在应用内直接导航。

## License

MIT
