# 文档模块重构设计方案（Excel / Word 在线查看·编辑·保存·导入·导出）

> 阶段一：仅设计，不实现。最终数据源 = SQLite（结构化 Document Model），禁止存原始文件，无独立 Office Server。

---

## 1. 技术选型结论

**首选：BetterOffice（openooxml/betteroffice）**

- **定位**：Rust 原生 OOXML 引擎（DOCX/XLSX/PPTX），编译到 **WASM** 供浏览器，同源码可作 **Rust crate** 跑后端，Apache-2.0 开源，无任何独立 Server 依赖。
- **组件**：
  - `@betteroffice/docx-react` / `@betteroffice/xlsx-react` —— React 19 编辑器（peer 兼容 react 18/19，项目现依赖 radix/sonner 已对齐）
  - `@betteroffice/docx` / `@betteroffice/xlsx` —— 无框架核心（WASM：解析、CRDT 编辑、排版/渲染、序列化）
  - `betteroffice-docx` / `betteroffice-xlsx`（crates.io）—— Rust 后端同引擎：打开/编辑/计算/布局/保存
  - `betteroffice-xlsx-calc` —— 公式解析、依赖图、重算引擎
- **为何唯一满足**：唯一同时满足 ①无独立部署引擎 ②WASM/Rust 双端同引擎（前后端模型一致）③Apache-2.0 可商用 ④直接暴露结构化 Document Model（非编辑器私有 JSON）的组合。
- **诚实风险声明**：当前 **0.1.0**，属早期版本——API 可能演进、部分高级 OOXML 特性保真度需 PoC 实证（见 §13、§14）。备选（仅在 BetterOffice 某项不达标时启用，见 §13）：DOCX 解析 `docx-rs`（Rust）/`docx-preview`（渲染兜底），XLSX 解析 `calamine`（Rust 只读）/`xlsx`（SheetJS）。**绝不引入 LibreOffice/ONLYOFFICE Server**。

---

## 2. 总体架构

```
┌────────────────────────────── 前端 (React) ──────────────────────────────┐
│  文档列表 / 版本面板          DocxEditor(@betteroffice/docx-react)       │
│                              XlsxEditor(@betteroffice/xlsx-react)        │
│                                       │ WASM（引擎在浏览器内）           │
└──────────────────────────────┬──────────────────────────────────────────┘
                               │ Document Model（JSON，Canonical）
                               ▼
┌────────────────────────────── Rust 后端 (Tauri) ─────────────────────────┐
│  导入：.docx/.xlsx → BetterOffice crate 解析 → Model → SQLite            │
│  保存：Model 校验/规范化 → SQLite（版本化）                               │
│  导出：Model → BetterOffice crate 序列化 → OOXML 字节                     │
│  SQLite：元数据 + Document Model + 版本 + 资源(BLOB)                      │
└──────────────────────────────────────────────────────────────────────────┘

模型生命周期： React 编辑器 ⇄ Canonical Document Model ⇄ SQLite ⇄ 导出 OOXML
（编辑器只是 View/Adapter；SQLite 是唯一 Source of Truth）
```

关键决策：**解析/序列化优先在 Rust 后端**（同 BetterOffice 引擎、可离线验证、文件不经前端大对象传递）；前端 WASM 引擎负责**编辑交互 + 实时渲染**，变更以**模型补丁**形式回传（自动保存）。

---

## 3. 前端架构

- `ToolDocuments`（工具箱入口，React.lazy）：列表 / 导入 / 版本历史 / 打开编辑器。
- 编辑器容器：按类型加载 `DocxEditor` 或 `XlsxEditor`（均为懒加载 chunk，参照现有 tool-documents 独立 chunk 模式，不并入主 bundle）。
- 编辑器数据流：
  - 打开：Rust 返回 Model JSON → 注入编辑器初始化。
  - 编辑：编辑器产生 CRDT/补丁变更 → 防抖 2s **自动保存** → Rust 校验 → 写 SQLite 版本。
  - 显式保存：手动「保存」/ Ctrl+S，强制快照。
- 渲染/编辑分离：WASM 负责 Canvas/DOM 渲染与交互；不把编辑器内部状态直接落库（见 §5 Canonical Model）。

---

## 4. Rust 后端架构（Tauri command 层）

- `documents_import(path)`：读文件字节 → BetterOffice crate 解析 → 规范化 Model → 事务写 SQLite（文档行 + 版本行 + 资源行）。
- `documents_get(id, version?)`：读 Model（默认最新版本）。
- `documents_apply_patch(id, patch, base_version)`：乐观并发校验（base_version 匹配才写）→ 新版本。
- `documents_export(id, version?, format)`：Model → BetterOffice 序列化 → OOXML 字节 → 保存对话框 / 返回字节。
- `documents_version_list(id)` / `documents_diff(a,b)` / `documents_restore(id, version)`。
- 引擎复用：前端 WASM 与后端 Rust 是**同一 BetterOffice 引擎**，模型结构天然一致（关键正确性保证）。

---

## 5. SQLite 数据模型

> 原则：元数据/结构/段落/单元格/样式/公式/页面配置/资源均**规范化存储**；禁止整文件字节列；图片等资源 BLOB；编辑器 JSON 只作为**视图快照**，不替代 Canonical Model。

```
documents                  -- 文档主表
  id TEXT PK
  name TEXT                -- 显示名
  kind TEXT                -- 'docx' | 'xlsx'
  source_name TEXT         -- 原始文件名（仅元数据，不含字节）
  source_hash TEXT         -- 导入源文件 SHA-256（去重/校验）
  size INTEGER
  head_version INTEGER     -- 当前版本号
  created_at / updated_at INTEGER

document_versions          -- 版本管理（每个保存 = 一个版本）
  id TEXT PK
  document_id TEXT FK
  version INTEGER          -- 单调递增
  model TEXT NOT NULL      -- Canonical Document Model（JSON，见 §6/§7）
  model_hash TEXT          -- 模型校验和（完整性）
  patch TEXT NULL          -- 自上一版本的变更集（增量，可选，用于 diff/回滚加速）
  base_version INTEGER NULL
  author TEXT NULL         -- 预留（多端）
  created_at INTEGER

document_resources         -- 图片等二进制资源（BLOB）
  id TEXT PK
  document_id TEXT FK
  kind TEXT                -- 'image' | 'font' | ...
  resource_id TEXT         -- 文档内引用 id（rId / 内部名称）
  data BLOB NOT NULL
  mime TEXT
  sha256 TEXT

documents_meta             -- 追加元数据（键值，规范化）
  document_id TEXT FK, key TEXT, value TEXT, PRIMARY KEY(document_id, key)
```

- 索引：`document_versions(document_id, version)`；`document_resources(document_id, resource_id)`。
- 迁移：新表走 `CREATE TABLE IF NOT EXISTS` + `ensure_column` 模式（沿用现项目 db.rs 机制）。

---

## 6. DOCX 数据模型（Canonical）

基于 BetterOffice Document 模型规范化（保留 OOXML 语义，非编辑器私有结构）：

```
DocxDocument
 ├─ settings        -- 页面配置：页边距/纸张尺寸/方向/页眉页脚距离
 ├─ sections        -- 节（分节符/页面设置/页眉页脚引用/分栏）
 │    └─ headers / footers（含页码字段）
 ├─ body            -- 块级元素序列
 │    ├─ paragraph  -- 段落
 │    │    ├─ style_ref          -- 样式 id
 │    │    ├─ numbering          -- 编号/列表属性
 │    │    ├─ alignment / indent / spacing / line_height
 │    │    ├─ tabs / borders / shading
 │    │    └─ runs              -- 文本 Run
 │    │         ├─ text（含制表/断行控制）
 │    │         ├─ font / size / bold / italic / underline / strike / color
 │    │         ├─ highlight / character spacing / baseline
 │    │         ├─ hyperlink（内部/外部）
 │    │         └─ break / tab / symbol
 │    ├─ table      -- 表格
 │    │    ├─ grid（列宽）
 │    │    ├─ rows → cells（合并：gridSpan / vMerge）
 │    │    ├─ 单元格内段落/表格嵌套
 │    │    └─ table style / borders / width
 │    ├─ image      -- 图片（引用 document_resources；尺寸/位置/环绕/裁剪）
 │    └─ content_control / bookmarks / comments 引用
 ├─ styles          -- 样式表（字符/段落/表格样式，继承链）
 ├─ numbering       -- 编号定义
 ├─ theme           -- 主题（字体集/颜色/效果）
 └─ unknown_parts   -- 未识别 OOXML 节点（原样保留，透传导出，保真兜底）
```

**保留未知节点是关键设计**：BetterOffice 解析时凡不认识的元素/部件，以结构化占位保留 → 导出时原样写回 → 未编辑区域与原始文件字节级一致。

---

## 7. XLSX 数据模型（Canonical）

```
XlsxWorkbook
 ├─ sheets[]            -- 工作表
 │    ├─ name / sheet_id / state(可见性)
 │    ├─ dimension
 │    ├─ cols            -- 列宽（customWidth / style）
 │    ├─ rows[]          -- 行
 │    │    ├─ row_index / height / customHeight / style
 │    │    └─ cells[]
 │    │         ├─ ref（A1）
 │    │         ├─ type: 'n' | 's' | 'b' | 'str' | 'e' | 'inlineStr'
 │    │         ├─ value
 │    │         ├─ formula（含共享公式 master/ref）
 │    │         ├─ style_index（引用 shared_styles）
 │    │         └─ hyperlink / comment
 │    ├─ merge_cells[]   -- 合并单元格（ref 范围）
 │    ├─ frozen          -- 冻结窗格（pane 配置）
 │    ├─ filters[]       -- 自动筛选（ref + 列）
 │    ├─ data_validations[] -- 数据验证（范围/规则/下拉）
 │    ├─ conditional_formats[] -- 条件格式（规则/公式/样式差异）
 │    ├─ hyperlinks[]
 │    ├─ images[]        -- 图片（锚点/尺寸 → resources BLOB）
 │    ├─ print_settings  -- 打印区域 / 页面设置 / 页眉页脚 / 缩放
 │    └─ drawing / charts（引用保留或降级，见 §13）
 ├─ shared_styles       -- 样式表（fonts/fills/borders/number_formats/alignment）
 ├─ defined_names       -- 定义名称
 ├─ calc_chain          -- 计算链（可选）
 ├─ tables[]            -- 表格对象（结构化引用/汇总行）
 └─ unknown_parts       -- 未识别部件原样保留
```

- 公式存**原字符串** + calc 引擎重算结果缓存；导出时优先保留原始公式（高保真），仅在用户编辑了相关单元格时触发重算。
- 数字格式/字体/边框/填充/对齐全部走共享样式索引（不复制内联），保证与原始文件一致。

---

## 8. 导入流程

```
1. 用户选择 .docx/.xlsx（对话框/拖拽）
2. Rust: documents_import
   a. 读字节 → SHA-256（source_hash）
   b. BetterOffice crate 解析（docx / xlsx）
   c. 抽取资源（图片等）→ document_resources（BLOB）
   d. 构建 Canonical Model JSON（含 unknown_parts 透传）
   e. 事务写入 documents + document_versions(version=1) + resources
3. 返回文档 id → 前端列表刷新
4. （可选）源文件哈希去重：同哈希再次导入 → 复用模型/提示
```

- 解析失败：返回结构化错误（文件损坏/加密/版本不支持），不写库。
- 文件大小上限沿用 10MB（可配置）。

---

## 9. 编辑 / 自动保存流程

```
1. 打开：Rust 读最新 Model → 前端注入编辑器（WASM 渲染）
2. 用户编辑 → 编辑器产生 CRDT/变更补丁（结构化 diff）
3. 自动保存（防抖 2s；或显式 Ctrl+S）：
   a. 前端 → documents_apply_patch(id, patch, base_version)
   b. Rust 校验 base_version == 当前 head
   c. 应用补丁到 Model → 新 Model
   d. 事务写 document_versions(version = head+1, model, patch, model_hash)
   e. 更新 documents.head_version
4. 冲突（base_version 不匹配，如双端同时编辑）：
   → 返回最新版本 → 前端提示并基于最新版 rebase/合并（CRDT 天然可合并）
5. 图片等资源变更：独立资源行 upsert（BLOB），Model 只存引用
```

- **版本粒度**：每次自动保存 = 一个版本。频繁保存产生多版本 → 提供「版本压缩/清理」（保留策略：最近 N 版全量 + 更早按 patch 链）。
- 心跳/草稿：未保存的编辑驻留前端；失焦/关闭弹窗时强制 flush 一次。

---

## 10. 导出流程

```
1. 选择版本（默认 head）→ documents_export(id, version)
2. Rust: Model JSON → BetterOffice crate 序列化
   a. 重建 OOXML 部件（docx: document.xml/styles/numbering/theme/media…）
   b. 资源（图片 BLOB）写回 media/ 部件
   c. unknown_parts 原样写回（未编辑区域保真）
   d. 打包 zip（OPC 容器，betteroffice-opc：zip-bomb/路径穿越防护）
3. 返回字节 → 保存对话框（.docx/.xlsx）或导出到用户选择路径
```

---

## 11. 版本管理方案

- **表**：`document_versions`（§5）——全量 Model + 增量 patch 双存。
- **操作**：
  - 版本列表（时间/版本号/变更摘要）
  - 查看历史版本（读该版本 Model 渲染只读预览）
  - 回滚：`documents_restore(id, v)` = 将 v 的 Model 复制为新版本（head+1），保留审计链（不覆盖历史）
  - Diff：patch 存储使相邻版本差异可见（列表/字段级）
- **保留策略**：每文档最多保留 N=50 全量版本 + 合并更早的 patch 链；可配置。
- **完整性**：model_hash 校验（写时计算，读时校验）。

---

## 12. 高保真策略

1. **同引擎双端**：前端 WASM 与后端 Rust 同一 BetterOffice 引擎 → 编辑所见即导出所得（模型级一致）。
2. **Canonical Model 保留 OOXML 语义**：样式走共享定义、公式存原文、合并/冻结/筛选/验证/条件格式全部建模。
3. **unknown_parts 透传**：未识别的元素/部件结构化保留 → 未编辑区域与原始文件一致（关键保真兜底）。
4. **资源引用**：图片等 BLOB 独立存储，导出按原 rId 引用写回，尺寸/位置/环绕属性保留在模型。
5. **公式策略**：未触及的公式保留原字符串（不重算、不重写）；仅编辑相关单元格才用 calc 引擎重算。
6. **导出前验证**：round-trip 校验（导出字节 → 重新解析 → 与导出前 Model 对比；关键属性 diff）。
7. **PoC 清单对照**：§14 的逐项属性在导入/导出后人工 + 程序化比对。

---

## 13. BetterOffice 能力与限制（诚实评估）

**已验证具备（文档/官方声明）**：
- DOCX：解析、CRDT 编辑、**页面排版渲染**、保存（`betteroffice-docx` typed API）
- XLSX：解析、**公式解析/依赖图/重算**（`betteroffice-xlsx-calc`）、样式/渲染/保存
- OPC 容器读写（zip-bomb/路径穿越防护）
- 同一引擎：Rust crate ↔ WASM ↔ React（模型一致）
- Apache-2.0，无 Server

**必须 PoC 实证（0.1.0 早期，能力边界未公开承诺）**：
- 分页保真（页眉页脚/页码/分页符跨页布局）
- 复杂公式函数覆盖（数组公式、跨簿引用）
- 条件格式/数据验证的编辑后保留
- 图表（chart parts）、OLE 对象——预计**降级为占位保留**（原样透传不渲染/不编辑）
- 宏（.docm/.xlsm）——不支持，明确降级

**风险与替代（不引入 Server）**：
- 若 BetterOffice 某特性（如分页渲染）在 PoC 不达标：
  - DOCX 渲染兜底：`docx-preview`（现有依赖）只读预览；编辑仍用 BetterOffice 模型
  - XLSX 解析兜底：`calamine`（Rust 只读）/ SheetJS（现有）作为**导入备用解析器**（模型归一化后仍落 SQLite）
- 若 BetterOffice API 演进导致锁定：Canonical Model 是**自有结构**，编辑器可替换而不动 SQLite（正是独立模型的收益）。

---

## 14. PoC 验证方案

**目标**：用真实 DOCX/XLSX 验证 `原始文件 → 导入 → Model → SQLite → 重载 → 导出 → 对比`。

**DOCX 测试集**（至少各 1 份）：
- 多段落含字体/字号/加粗/斜体/下划线
- 标题层级 + 行距 + 缩进 + 页边距
- 页眉页脚 + 页码
- 表格 + 合并单元格 + 嵌套
- 图片（尺寸/位置/环绕）
- 多页文档（分页检查）
- 超链接 + 样式继承

**XLSX 测试集**：
- 多 Sheet + 单元格（字符串/数字/布尔/日期格式）
- 公式（基础 + 引用 + 跨 Sheet + 共享公式）
- 样式（字体/填充/边框/对齐/数字格式）
- 合并单元格 + 行高列宽 + 冻结窗格 + 筛选
- 数据验证 + 条件格式 + 超链接
- 图片 + 打印区域/页面设置

**验证步骤**（每类文件）：
1. 导入 → 检查 Model（结构/样式/公式/资源引用完整）
2. 重载（关编辑器 → 重开）→ 渲染一致
3. 不做任何编辑直接导出 → 与原文件**程序化对比**（解包对比 XML 部件、资源字节）
4. 做代表性编辑（改文字/单元格/样式）→ 导出 → 视觉 + 结构对比
5. 记录每项属性「保持 / 丢失 / 降级」→ 输出对照表

**通过标准**：步骤 3 未编辑区域与原文件部件一致（unknown_parts 透传生效）；步骤 4 编辑区域符合预期、未编辑区域不受影响。

---

## 15. 实施阶段划分

| 阶段 | 内容 | 里程碑 |
|---|---|---|
| **P0 PoC** | 装 BetterOffice（docx-react/xlsx-react + crate）；跑 §14 测试集；产出「属性保持对照表」；定 Canonial Model v1 | 对照表 + 决策（继续 / 换兜底） |
| **P1 数据层** | SQLite 表（documents/versions/resources/meta）+ 导入命令 + 版本命令；文档列表 UI | 导入 → SQLite → 列表 |
| **P2 查看/编辑** | 集成 docx-react / xlsx-react 编辑器（懒加载）；编辑 → 自动保存（补丁 + 版本） | 可编辑 + 自动保存 |
| **P3 导出/版本** | 导出命令（模型 → OOXML）；版本历史 UI（列表/预览/回滚） | 完整 round-trip + 版本管理 |
| **P4 打磨** | 大文件分页/虚拟滚动、公式重算策略、资源清理、保留策略、性能 | 生产可用 |

**P0 是硬门槛**：BetterOffice 0.1.0 的保真度未经验证前，不进入数据层建设（避免返工）。

---

## 附：与当前实现的差异（现状 → 目标）

- 现状：`documents.content` 存 base64 原文件（违反新约束）→ 目标：删除该列，改存 Model
- 现状：SheetJS + TanStack 自建表格 / TipTap 自建文档 → 目标：BetterOffice React 编辑器（引擎级 OOXML 保真）
- 现状：单版本 → 目标：版本表 + 自动保存 + 回滚
- 现状：编辑存 HTML/JSON（非规范模型）→ 目标：Canonical Document Model
