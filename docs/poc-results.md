# P0 PoC 结果：BetterOffice round-trip 保真对照表

> 测试集：`src-tauri/tests/fixtures/`（真实 OOXML，含公式/合并/冻结/筛选/数据验证/条件格式/图片/页眉页脚/表格/样式）
> 测试代码：`src-tauri/tests/roundtrip_poc.rs`（6 个用例全过，0.31s）

## 验证路径

| 文件 | 路径 | 结果 |
|---|---|---|
| XLSX | 原始 → `Workbook::open` → 模型提取 → `from_model` → `save` → 重开对比 | ✅ 全过 |
| XLSX | 模型级编辑（set_cell）→ save → 重开 | ✅ 值保持 |
| DOCX | 原始 → `Document::open` → 模型提取 | ✅ 内容/表格/页眉页脚/图片解析 |
| DOCX | open → save（引擎重写）→ 重开 + 部件对比 | ✅ 内容/表格/media/header/footer 保留 |
| DOCX | 编辑（replace_paragraph_text）→ save → 重开 | ✅ 文本保留 |

## 属性保持对照表

### XLSX ✅（模型级全保持，可走 SQLite）

| 属性 | 导入 | round-trip | 编辑后导出 | 备注 |
|---|---|---|---|---|
| Sheet（多表） | ✅ | ✅ | ✅ | `sheet_by_name` |
| Cell 值（文本/数字） | ✅ | ✅ | ✅ | `CellValue` |
| Formula（原文） | ✅ | ✅ | ✅ | `=B2*C2` 原文保留 |
| Merge（合并单元格） | ✅ | ✅ | ✅ | `merges` 向量 |
| Freeze Pane（冻结） | ✅ | ✅ | ✅ | `freeze_pane` |
| Col Width / Row Height | ✅ | ✅ | ✅ | 映射表 |
| 样式（样式表索引） | ✅ | ✅ | ✅ | `style` 索引 |
| 数字格式 | ✅ | ✅ | ✅ | 随样式索引 |

**待验证（后续阶段）**：条件格式、数据验证、筛选、超链接、图片、打印设置——模型字段存在（Sheet 有 hyperlinks/charts 等），需追加断言。

### DOCX ⚠️（查看/编辑可行，但「SQLite 存模型」受阻）

| 属性 | 导入 | open→save 重写 | 编辑后导出 |
|---|---|---|---|
| 段落文本 | ✅ | ✅ | ✅ |
| 标题 | ✅ | ✅ | ✅ |
| 表格 | ✅ | ✅ | ✅ |
| 图片（media） | ✅ | ✅ | ✅ |
| 页眉/页脚 | ✅ | ✅ | ✅ |
| 样式/字体/加粗斜体 | ✅ | ✅ | ✅（模型含） |
| 分页/布局 | — | 引擎 layout 存在，保真待视觉验证 | — |

**PoC 关键发现（DOCX）**：
1. `betteroffice-docx::DocumentModel` **未实现 serde**（`#[derive(Clone, Debug, PartialEq)]`，无 Serialize/Deserialize）
2. `Document` **无 `from_model`**（xlsx 有 `Workbook::from_model`）——无法从外部模型重建 Document
3. 结论：**「SQLite 存 DOCX 模型 JSON → 重建导出」链路当前不可行**，仅支持 Document 生命周期内（open→编辑→save）的字节流往返

## 结论与决策

1. **XLSX**：✅ 完整满足——模型可序列化（子结构带 serde）、可重建、可编辑、可导出。SQLite 方案（元数据 + 模型 JSON + 版本）直接可用。
2. **DOCX**：⚠️ 引擎本身解析/编辑/保存/保真均通过，但**缺少模型持久化的两个 API**（serde + from_model）。
   - 应对（按优先级）：
     a. **向 BetterOffice 提交 feature request**（`from_model` + `DocumentModel: Serialize/Deserialize`）——引擎已具备能力，仅 API 缺口
     b. **自实现 wire 序列化**：`docx_parse::serializer`（`S13SaveRequest` / `write_docx_s13`）是公开的，可从自有 DTO 构建 wire 结构导出（中等工作量，可做 PoC-2）
     c. 过渡期：DOCX 编辑走「Document 生命周期内」字节流（导入字节 → 编辑 → 保存字节），SQLite 存**编辑后字节的哈希 + 元数据**（暂不满足"模型化"约束，需用户确认是否接受过渡）
3. **前端 React 包**：`@betteroffice/docx-react` / `xlsx-react` 已装，props 为 `file: Uint8Array` + `onSave: (bytes)`（字节流模式），React 18/19 兼容——编辑器集成无阻塞。

## 下一步（P0-2，可选）

- 追加 XLSX 条件格式/数据验证/超链接/图片 round-trip 断言
- DOCX：向 upstream 提 issue 或实现 wire 导出 PoC
- 前端：最小 React 集成（XlsxEditor 加载 fixture → 显示 → onSave 拿字节）
