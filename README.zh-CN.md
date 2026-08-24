<div align="center">

# NexTerm

**面向远程服务器、终端、文件、文档与 API 调试的一体化原生桌面工作区。**

[English](README.md) · [功能特性](#功能特性) · [开发](#开发) · [贡献](#贡献)

[![License](https://img.shields.io/github/license/guojianfeng0525-debug/NexTerm)](LICENSE)
[![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri)](https://tauri.app/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)](https://react.dev/)
[![Rust](https://img.shields.io/badge/Rust-2021-orange?logo=rust)](https://www.rust-lang.org/)

</div>

---

## 项目简介

NexTerm 是一款基于 React、TypeScript、Tauri 2 和 Rust 构建的桌面客户端。它将远程连接、交互式终端、文件操作、系统监控、文档工具、开发工具和 API 调试整合在同一个可调整布局的工作区中。

> NexTerm 基于 R-Shell 代码库进行开发。上游项目请参阅 [R-Shell](https://github.com/GOODBOY008/r-shell)。

## 功能特性

### 连接与终端

- 支持 SSH、SFTP、FTP、FTPS、RDP 和 VNC 连接。
- 支持密码、密钥、代理、跳板机及协议专属认证配置。
- 基于 xterm.js 和 WebSocket PTY 的终端，支持搜索、链接、图片、IME/CJK 输入和外观定制。
- 支持终端分屏、拖拽标签、会话恢复、重连和布局持久化。
- 支持连接文件夹、收藏、标签、配置档案和服务器资源摘要。

### 文件与远程操作

- 双栏本地/远程文件管理，支持传输队列、进度、重试与目录操作。
- 支持目录同步、比较、审阅、同步方向与排除规则。
- 支持远程进程、系统、网络、GPU 和日志监控。
- 日志可从文件、journalctl、Docker 和自定义路径读取。

### 工具箱

- 常用本地应用、远程隧道、本地服务和服务编排。
- 加密记录本和记事本。
- Word/Excel 文档导入、编辑、版本历史和原生文档导出。
- JAR/WAR/EAR 查看、反编译、搜索、源码跳转、依赖浏览和源码导出。

### API 调试器

- REST 方法、请求集合、环境变量、变量替换、Basic/Bearer/API Key 认证和请求历史。
- 支持 Raw JSON、URL 编码表单和带文件上传的 multipart/form-data。
- 支持响应流式预览、大小限制、取消请求、响应元信息、JSON/原始视图和二进制响应。
- 支持状态码、响应头、JSON 路径和响应时间的安全声明式断言。
- 支持按分组顺序执行的 Collection Runner 和失败即停报告。
- 支持 WebSocket 调试、消息历史、截断限制、连接状态和显式关闭。

### 数据与安全

- 使用 SQLite 规范化持久化，敏感字段由应用锁保护并加密保存。
- 配置可导出/导入为 ZIP；导出前必须验证应用锁密码。
- 每份文档仅保留最近三个历史版本。

## 截图

<div align="center">
  <img src="screenshots/app-screenshot.png" alt="NexTerm 工作区" width="100%">
</div>

## 技术栈

| 层级 | 主要技术 |
| --- | --- |
| 桌面端 | Tauri 2、Rust、Tokio |
| 前端 | React 19、TypeScript、Vite、Tailwind CSS |
| 终端 | xterm.js、WebSocket PTY 流 |
| 远程协议 | russh、russh-sftp、suppaftp、RDP、VNC |
| 存储 | SQLite、AES-GCM 字段加密 |
| UI | Radix UI、shadcn/ui、Lucide、Recharts |

## 开发

### 前置条件

- Node.js 18 或更高版本
- pnpm 9
- Rust 和 Cargo
- 平台对应的 Tauri 依赖，参见 [Tauri 前置条件文档](https://v2.tauri.app/start/prerequisites/)

### 启动

```bash
git clone https://github.com/guojianfeng0525-debug/NexTerm.git
cd NexTerm
pnpm install

# 仅启动前端，启用 Vite Fast Refresh
pnpm dev

# 启动完整桌面应用，启用 Tauri 和 Vite 热更新
pnpm tauri dev
```

使用 `pnpm tauri dev` 时，修改 `src/` 下的前端文件会触发 Vite Fast Refresh；修改 Rust 代码会重新构建后端。

### 构建

```bash
pnpm build
pnpm tauri build
```

### 测试与检查

```bash
pnpm test
pnpm exec tsc --noEmit
pnpm lint
pnpm i18n:check

cd src-tauri
cargo test
```

## 项目结构

```text
NexTerm/
├── src/
│   ├── components/        # React 功能、终端、工具箱和 UI 基元
│   ├── lib/               # 状态、持久化、国际化和 API 调试逻辑
│   └── locales/           # 英文和简体中文翻译
├── src-tauri/
│   └── src/
│       ├── ssh/           # SSH/SFTP 实现
│       ├── commands.rs    # Tauri IPC 命令
│       ├── toolbox.rs     # 隧道、服务、API 与 WebSocket 工具
│       ├── documents.rs   # Word/Excel 文档后端
│       └── websocket_server.rs # PTY 流服务
├── screenshots/
└── scripts/
```

## 贡献

欢迎提交贡献、问题报告和文档改进。

1. Fork 本仓库。
2. 创建分支：`git checkout -b feature/your-change`。
3. 提交前运行相关检查。
4. 创建 Pull Request，并说明问题、方案和验证方式。

贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 许可证

[MIT](LICENSE)

## 链接

- [Issues](https://github.com/guojianfeng0525-debug/NexTerm/issues)
- [Discussions](https://github.com/guojianfeng0525-debug/NexTerm/discussions)
- [Pull requests](https://github.com/guojianfeng0525-debug/NexTerm/pulls)
- [上游项目：R-Shell](https://github.com/GOODBOY008/r-shell)
