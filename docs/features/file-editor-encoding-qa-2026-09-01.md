# 服务器文件在线编辑编码转换 QA 验收报告

- 日期：2026-09-01
- 范围：SSH 远程文本文件编辑器编码选择、按编码读取、保存时编码转换
- 结果：**✅ PASS**

## 1. 功能覆盖

| 能力 | 结论 |
|------|------|
| 编辑器工具栏显示编码选择器 | ✅ |
| 干净缓冲区切换编码 → 用新编码重新读取同一远程文件 | ✅ |
| 已修改缓冲区切换编码 → 不丢编辑，保存时按目标编码写入 | ✅ |
| UTF-8 / GBK / GB18030 / Big5 / Shift_JIS / EUC-JP / EUC-KR / Windows-1252 / ISO-8859-1 | ✅ |
| UTF-8 BOM 读取时剥离、保存时不重复写入 | ✅ |
| 目标编码无法表示的字符 → 保存报错而非静默替换 | ✅ |

## 2. 测试与 E2E

| 线路 | 结果 |
|------|------|
| `pnpm test` | 118 files / 1082 tests 全过 |
| Rust `encoding_tests` | GBK round-trip、UTF-8 BOM、非法编码/不可表示字符 3/3 通过 |
| `pnpm build` | PASS |
| `pnpm lint` | 0 error / 242 warnings |
| `pnpm i18n:check` | 2227/2227 keys |
| `cargo test` | 308 passed / 0 failed / 18 ignored |
| `file-editor-encoding.e2e.ts` | 真实 SSH fixture + GBK 远程文件，1/1 PASS（2.8s） |

E2E 路径：

1. 通过 `create_file_with_encoding` 在 `/tmp` 写入真实 GBK 文件。
2. 打开独立文件编辑器，默认 UTF-8 视图确认不能正确解析。
3. UI 切换 GBK 后等待 CodeMirror 显示正确中文内容。
4. 通过 `read_file_content_with_encoding` 复核远程字节以 GBK 解码无错误。
5. 删除 fixture 文件。

## 3. MCP 纯视觉复审

审核提示明确禁止 OCR/文字识别/逐字转写，仅检查布局、状态与渲染形态。

| 截图 | 结论 | 摘要 |
|------|------|------|
| 01-default-utf8-view.png | ⚠️ 预期 WARN | 工具栏/编码控件/编辑区布局完整；内容出现替换字形，这是 GBK 字节按 UTF-8 解码的预期表现，也是本用例的前置断言。 |
| 02-gbk-view.png | ✅ PASS | 布局稳定，编码控件完整可用，编辑区无裁切/重叠/残影；切换编码后布局未跳动。 |

## 4. 设计说明

- 干净缓冲区切换编码语义是“重新解码远程字节”，用于查看 GBK/Big5 等旧文件。
- 已修改缓冲区切换编码语义是“保存时转换”，避免切换选项时丢失用户编辑。
- 后端通过 SFTP 读取原始字节后用 `encoding_rs` 解码，避免旧 `cat` 路径先强制 UTF-8 造成不可逆替换。
