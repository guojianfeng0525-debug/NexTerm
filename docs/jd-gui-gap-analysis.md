# JD-GUI 1.6.6 完整功能复刻差距分析（逐事件）

> 依据：JD-GUI 1.6.6 官方源码（github.com/java-decompiler/jd-gui，tag v1.6.6）逐文件审计，
> 与 NexTerm JAR 反编译模块（`tool-jar-decompiler.tsx` + `jar_commands.rs` 等）逐项对照。
> 结论：**当前实现了 JD-GUI 约 1/4 的功能面；差距主要集中在全局索引型功能（Open Type、
> 类型层次、常量池搜索）、编辑器交互事件、多文件/多容器架构、偏好设置**。

---

## 一、主框架 / 菜单（MainView.java + MainController.java）

| # | JD-GUI 事件/功能 | 触发 | 当前 NexTerm | 差距 |
|---|---|---|---|---|
| 1 | File > Open File... 打开文件（jar/war/ear/zip/aar/kar/java/class/log 全格式） | 菜单 / Ctrl+O / 工具栏按钮 | ✅ 仅 .jar（文件选择器）+ pom.xml | 仅 jar/pom，无 class/java/zip/war 等 |
| 2 | File > Close 关闭当前标签 | 菜单 / Ctrl+W | ✅ 标签 ✕ 按钮 | 无 Ctrl+W 快捷键、无"关闭面板"菜单 |
| 3 | File > Save 保存当前页源码到文件 | 菜单 / Ctrl+S | ❌ 无（我们的是"保存修改入库"语义不同） | **JD-GUI 是导出源码文件；我们是写回 SQLite 修改** |
| 4 | File > Save All Sources 导出全部源码（zip 或目录） | 菜单 / Ctrl+Alt+S / 工具栏 | ✅ 导出全部源码（选目录） | 无 zip 选项、无进度对话框 |
| 5 | File > Recent Files 最近文件子菜单 | 菜单（动态） | ✅ 最近文件下拉 | 已实现 |
| 6 | File > Exit 退出 | 菜单 / Alt+X | ✅ Tauri 窗口关闭 | 无应用内 Exit |
| 7 | Edit > Copy 复制 | 菜单 / Ctrl+C | ✅ CodeMirror 原生 | 无选区复制空串（JD-GUI 复制空） |
| 8 | Edit > Paste Log 粘贴剪贴板文本为日志文件页 | 菜单 / Ctrl+V | ❌ | **缺失：JD-GUI 能把剪贴板文本当文件打开** |
| 9 | Edit > Select all 全选 | 菜单 / Ctrl+A | ✅ CodeMirror 原生 | OK |
| 10 | Edit > Find... 底部查找面板 | 菜单 / Ctrl+F | ⚠️ CodeMirror 内置搜索 | **无 JD-GUI 式底部 Find 面板（实时高亮/大小写/历史/上一下一）** |
| 11 | Navigation > Open Type... 全局类型搜索对话框 | 菜单 / Ctrl+T / 工具栏 | ⚠️ 只有左侧树内过滤（底部 search tab） | **缺失跨文件全局类搜索弹窗 + 智能匹配（大小写敏感/通配符）** |
| 12 | Navigation > Open Type Hierarchy... 类型层次树 | 菜单 / Ctrl+H | ❌ | **缺失（父类/子类层级浏览器）** |
| 13 | Navigation > Go to Line... 跳转行 | 菜单 / Ctrl+L | ❌ | **缺失（行号输入跳转）** |
| 14 | Navigation > Back / Forward 浏览历史 | 菜单 / Alt+← / Alt+→ / 工具栏 | ❌ | **缺失（页面浏览历史前后导航）** |
| 15 | Search > Search... 常量池搜索 | 菜单 / Ctrl+Shift+S / 工具栏 | ❌ | **缺失（跨 jar 搜索常量：字符串/字段/方法/类型/模块/声明/引用，8 个勾选 flag）** |
| 16 | Help > JD Web site / issues / About | 菜单 / F1 | ❌ | 缺失（可后补） |
| 17 | Help > Preferences... 偏好设置 | 菜单 / Ctrl+Shift+P | ❌ | **缺失（字体大小、CFR 参数、单实例、标签布局等 6 个偏好面板）** |
| 18 | 空状态引导页（"No files are open" + 操作提示） | 启动无文件 | ⚠️ 简单提示 | JD-GUI 有专门引导面板 |

## 二、树面板交互事件（TreeTabbedPanel.java + Tree.java）

| # | JD-GUI 事件 | 当前 | 差距 |
|---|---|---|---|
| 1 | 单击树节点 → 打开页面（单击即开，非双击） | ✅ 单击打开 | OK |
| 2 | 树展开事件 → 懒加载子节点（TreeNodeExpandable.populateTreeNode） | ⚠️ 一次性索引全部 | 大数据 jar 无懒加载（性能） |
| 3 | 右键树节点 → 上下文菜单（Copy Qualified Name 复制限定名） | ❌ | **缺失：树右键菜单** |
| 4 | 树节点 tooltip：文件位置 + Java 编译版本（major.minor → Java X） | ⚠️ 只有类信息面板按钮 | tooltip 缺失（我们做了等价类信息面板） |
| 5 | 包节点聚合：单子目录自动合并显示为 a.b.c | ❌ 按原始路径 | 显示差异 |
| 6 | 内部类（Foo$Inner）在树中隐藏/归类 | ✅ 显示为独立类 | 显示策略不同（JD-GUI 树过滤 $ 内部类） |
| 7 | 资源文件节点：图片(gif/jpg/png)/文本/属性文件各自图标 | ✅ 统一 📄 + 预览 | 无分类图标体系 |
| 8 | META-INF 特殊分组（MANIFEST.MF 图标等） | ⚠️ 当普通资源 | 无 META-INF 分组展示 |
| 9 | 双击文本 → 高亮所有相同文本（绿色 markAll） | ❌ | **缺失：双击选中词高亮所有出现** |
| 10 | 树选中联动标签页（页面切换时反向选中树节点） | ❌ 无 | **缺失：标签切换 ↔ 树选中双向同步** |

## 三、编辑器页面事件（AbstractTextPage.java + TypePage.java + HyperlinkPage.java）

| # | JD-GUI 事件 | 当前 | 差距 |
|---|---|---|---|
| 1 | **单击**类型/方法/字段引用 → 跳转打开目标（可点击超链接，悬停手型光标+下划线） | ⚠️ **Ctrl/Cmd+click** 才跳转 | **JD-GUI 是普通单击跳转 + 悬停反馈（下划线/手型），我们需修饰键且无悬停提示** |
| 2 | 悬停引用 → HAND_CURSOR + token 下划线 | ❌ | 缺失视觉反馈 |
| 3 | 跨容器引用 → 弹出 SelectLocation 多位置选择 | ❌ 仅单 jar | 缺失多 jar 命中选择 |
| 4 | Ctrl+滚轮 → 字体缩放（并持久化偏好） | ❌ | 缺失 |
| 5 | 双击单词 → 全部相同文本高亮 | ❌ | 缺失（CodeMirror 有 highlightSelectionMatches 但无双击触发色） |
| 6 | 行号 + 代码折叠 gutter + 折叠图标 | ✅ CodeMirror 折叠/行号 | OK |
| 7 | 右缘错误条 RoundMarkErrorStrip | ❌ | 缺失（我们有底部 Problems 面板） |
| 8 | Eclipse 主题配色 | ✅ 默认配色 | 可加主题选择 |
| 9 | 只读查看 + 复制 | ⚠️ 我们可编辑 | 我们更强（可编辑） |
| 10 | 方法声明位置高亮（fragment=类型-方法-描述符 定位） | ✅ 方法导航跳行 | 已实现等价物 |
| 11 | 字符串常量可点击跳转 | ❌ | 缺失 |
| 12 | 字体大小偏好（ViewerPreferences.fontSize） | ❌ | 缺失偏好系统 |

## 四、查找面板（MainView 底部 Find 栏）

| # | JD-GUI 行为 | 当前 | 差距 |
|---|---|---|---|
| 1 | 输入 >1 字符实时高亮所有匹配（黄色） | ⚠️ CodeMirror 高亮选区匹配 | 行为近似但无独立面板 |
| 2 | Next / Previous 按钮 + 回车循环查找 | ✅ | 部分 |
| 3 | Case sensitive 复选框 | ⚠️ CodeMirror 搜索选项 | 有等价 |
| 4 | 查找历史下拉（最近 10 条） | ❌ | 缺失 |
| 5 | 无匹配 → 输入框红底反馈 | ❌ | 缺失 |
| 6 | Esc 关闭面板 | ✅ | OK |

## 五、标签页事件（TabbedPanel.java + MainTabbedPanel.java）

| # | JD-GUI 行为 | 当前 | 差距 |
|---|---|---|---|
| 1 | 标签关闭按钮（hover 变红） | ✅ ✕ 按钮 | OK |
| 2 | **标签右键菜单：Close / Close Others / Close All / Select Tab / Copy Qualified Name** | ✅ Close/Others/All/CopyName | 无 Select Tab 子菜单（多标签快速切换） |
| 3 | 标签切换 → 同步树选中 + 更新窗口标题 + 更新菜单启用态 + 更新历史 | ⚠️ 切标签开新视图 | 标题/树同步/菜单态缺失 |
| 4 | 多个文件同时打开（多主面板） | ❌ 单项目 | **缺失：一次只能开一个 jar；JD-GUI 可多 jar 并行（Open Type 跨全部）** |
| 5 | 关闭全部 → 空状态引导页 | ✅ 清空 | OK |

## 六、全局索引型功能（核心差距，工作量最大）

| # | JD-GUI | 当前 | 说明 |
|---|---|---|---|
| 1 | **Open Type（Ctrl+T）**：跨所有已打开 jar 搜索类型，正则智能匹配（大写=精确、小写=忽略大小写、`*`/`?` 通配），结果列表即时过滤 + 增量缓存 | ❌ | 需全 jar 索引 + 搜索对话框 + 匹配算法 |
| 2 | **Open Type Hierarchy（Ctrl+H）**：显示父类/接口/子类层级树，可展开跳转 | ❌ | 需 super/sub 类型索引（JD-GUI 用 Indexer 建 subTypeNames/superTypeNames 反向索引） |
| 3 | **Search in Constant Pools（Ctrl+Shift+S）**：跨 jar 搜常量池，8 个 flag（类型/构造器/方法/字段/字符串/模块/声明/引用）+ 结果树按包分组 + 计数 | ❌ | 需全量字符串/引用索引（我们只有方法名索引） |
| 4 | **Indexer 体系**：typeDeclarations/typeReferences/constructorDeclarations/methodDeclarations/fieldDeclarations/strings/subTypeNames/superTypeNames 8 类索引，异步后台执行 | ⚠️ 仅方法名+类名 | 索引覆盖不足 |

## 七、保存/导出事件（SourceSaver + SaveAllSourcesController）

| # | JD-GUI | 当前 | 差距 |
|---|---|---|---|
| 1 | Save All Sources：整 jar 批量反编译导出为 zip 或目录，带进度对话框 + 失败计数 | ✅ 导出目录（无 zip 选项） | 无 zip、无进度对话框 |
| 2 | Save 当前页：源码另存为文件 | ❌ | 我们保存是"写回修改"，JD-GUI 是导出文件——语义不同需澄清 |
| 3 | 导出结构：包目录层级 | ✅ | OK |

## 八、多容器/文件类型支持（ContainerFactory/FileLoader/TreeNodeFactory）

| # | JD-GUI 支持 | 当前 | 差距 |
|---|---|---|---|
| 1 | jar/war/ear/zip/aar/kar/Java module 容器 | ❌ 仅 jar | 缺失 |
| 2 | 嵌套容器（jar 内嵌 jar/war，EarContainer 等） | ❌ | 缺失（依赖库支持了一部分） |
| 3 | 单 .class 文件直接打开 | ❌ | 缺失 |
| 4 | .java 源文件查看（JavaFilePage + ANTLR 语法高亮） | ❌ | 缺失 |
| 5 | 日志文件查看 + Paste Log | ❌ | 缺失 |
| 6 | 资源文本/图片/属性查看 | ✅ | OK |

## 九、偏好设置（PreferencesPanelService，6 面板）

| 面板 | 内容 | 当前 |
|---|---|---|
| Main window | 单实例开关、窗口状态持久化 | ❌ |
| Tabs | 单行/多行标签布局 | ❌ |
| Class file（CFR） | 反编译参数 | ❌ |
| Class file（保存） | 保存行为 | ❌ |
| Directory exploration | 目录索引深度 | ❌ |
| Appearance（Viewer） | 字体大小等 | ❌ |

---

## 已实现功能清单（对照确认，非全无）

- 打开 jar、拖拽打开、最近文件、pom 依赖库、库切换
- 包树浏览、单击打开类、多标签 + 关闭/关闭其他/关闭全部 + 标签右键复制类名
- CFR 反编译、编辑保存修改、revert、javac 编译、构建 jar、导出全部源码
- 类信息面板（Java 版本/major/size）、方法导航跳行、Ctrl/Cmd+click 跳转
- 资源预览（图片/文本/hex）、类树实时过滤搜索、状态栏、Problems/Output/Search 底部面板
- 实时 CFR（不缓存）JD-GUI 语义、依赖 jar 只读

## 差距按优先级建议（P0 核心体验 → P2 锦上添花）

**P0（JD-GUI 体验标志，缺失即"没实现三分之一"）**
1. **Open Type 全局类搜索（Ctrl+T）**：跨 jar 搜索 + 智能匹配 + 结果弹窗
2. **单击跳转 + 悬停反馈**：把 Ctrl/Cmd+click 改成单击可点（带下划线/手型提示）
3. **Open Type Hierarchy（Ctrl+H）**：父/子类型树（需 subTypeNames 索引）
4. **Go to Line（Ctrl+L）**

**P1（高频交互补齐）**
5. **常量池搜索（Ctrl+Shift+S）**：字符串/字段/方法跨 jar 搜索（依赖索引扩展）
6. **Back/Forward 历史导航（Alt+←/→）**
7. **双击高亮所有相同文本**
8. **Ctrl+滚轮字体缩放**
9. **标签右键 Select Tab 子菜单**
10. **树右键菜单（复制限定名）**
11. **标签切换 ↔ 树选中双向同步 + 窗口标题更新**

**P2（架构级/锦上添花）**
12. 多 jar 并行打开（多主面板）——牵动 Open Type/常量池搜索的数据模型
13. 索引体系扩展（8 类索引 + 异步后台）
14. 嵌套容器/更多文件类型
15. 偏好设置面板（字体/CFR 参数/标签布局）
16. Save All Sources zip 输出 + 进度
17. Paste Log、META-INF 分组、包节点聚合、内部类隐藏策略

> 注：本分析基于 JD-GUI 1.6.6 源码逐事件审计；"三分之一"的判断成立——
> 我们实现了主干查看/编辑/构建链路，但 JD-GUI 的全局导航型功能（Open Type、
> Hierarchy、常量池搜索）、编辑器交互细节、多容器架构均未覆盖。

---

## 复刻进度更新（2025 实施完成）

### P0 ✅（JD-GUI 体验标志）
| 功能 | 状态 |
|---|---|
| Open Type 全局类搜索 (Ctrl+T) | ✅ 后端 `jar_open_type` 精确移植 JD-GUI 匹配算法（简单类名 + 大写边界 + 通配符），前端弹窗即时过滤/键盘导航；scope 可切"当前/全部已打开项目"（P2-5 增强） |
| 单击跳转 + 悬停反馈 | ✅ 普通单击已知类名跳转；悬停蓝色虚线下划线 + 手型光标 |
| Open Type Hierarchy (Ctrl+H) | ✅ 后端 `class_super`/`jar_type_hierarchy`（常量池解析，真实 javac 验证），前端父链+子树弹窗 |
| Go to Line (Ctrl+L) | ✅ 行号跳转 + scrollIntoView |

### P1 ✅
| 功能 | 状态 |
|---|---|
| 常量池搜索 (Ctrl+Shift+S) | ✅ `parse_class_pool` 收集字符串/字段/方法引用，`jar_constant_search` 跨 jar 搜索，弹窗带 3 flag |
| Back/Forward 历史 (Alt+←/→) | ✅ 导航栈 + 工具栏按钮 |
| 双击高亮相同文本 | ✅ 绿色 markAll |
| Ctrl+滚轮字体缩放 | ✅ 8-28px + localStorage 持久化 |
| 标签右键 Select Tab | ✅ |
| 树右键复制限定名 | ✅ |
| 标签↔树双向同步 + 标题 | ✅ scrollIntoView + document.title |

### P2 ✅
| 功能 | 状态 |
|---|---|
| 偏好设置 (Ctrl+Shift+P) | ✅ 字体大小 / 标签布局（单行滚动/多行换行） |
| Save All Sources zip | ✅ 后端 zip 打包（staging→zip），前端先问 zip 再回退目录 |
| Paste Log (Ctrl+V) | ✅ 剪贴板→只读日志查看器 |
| META-INF/内部类隐藏 | ✅ normalizeTree 过滤 $ 内部类 |
| 跨项目 Open Type | ✅ scope=all 扫全部已索引项目（jar_project_reopen） |
| war/ear/zip 容器 | ✅ 打开/拖拽过滤器扩展（zip 兼容） |

### 验证
- `cargo test` 185 通过（+9 新增：open_type 6 + class_super 3）
- 集成测试 7 组全过（含 jar_hierarchy：继承链 + 常量池收集，真实 javac）
- `tsc` / `pnpm build` / `pnpm test` 616 全过

### 剩余可选（未实施，JD-GUI 有但价值较低）
- 单 .class / .java 文件直接打开（需新容器模型）
- 嵌套容器（jar 内嵌 war）
- 偏好面板中的 CFR 参数 / maven.org 在线源码下载
- Help 菜单（网页链接/About）

---

## 引用跳转机制升级（对齐 JD-GUI 源码，2025 实施）

### JD-GUI 机制（源码实证）
- **引用来自字节码**：`ClassFilePage.ClassFilePrinter.printReference` 在反编译时从常量池精确输出每个引用的 `internalTypeName`（如 `org/apache/commons/io/IOUtils`）+ 精确源码偏移，注册为超链接——**不是猜单词**。
- **跨容器解析**：`openHyperlink` → `IndexesUtil.findInternalTypeName` 遍历所有已打开容器的 `typeDeclarations` 索引。
- **嵌套 jar**：`GenericContainer.Entry.loadChildrenFromFileEntry` 对任何文件条目用 `FileSystems.newFileSystem` 递归打开——jar 嵌 jar 任意深（Spring Boot BOOT-INF/lib）。
- **不可解析引用静默**：`indexesChanged` 时 enabled=false 的引用不显示、点击无反应。

### 我们的升级
1. **字节码级引用**：`parse_class_pool` 扩展 `refs: Vec<ClassRef>`（internalTypeName + kind + descriptor），jar_decompile/revert 返回 refs。前端 `refsMapRef`（简单名→内部名）替换猜词 classNameSet 为主判断——同包类 `Bar` 精确解析为 `demo/Bar`，单击即跳。
2. **跨项目 fallback**：jar_navigate 当前项目找不到时搜所有已索引项目，前端自动 reopen 目标 jar。
3. **嵌套 jar 索引**：jar_project_open 扫描 BOOT-INF/lib、WEB-INF/lib 等嵌套归档，解压到 scratch 作为只读库（`[nested]` 标记）索引全部类；reopen 时自动重建缺失的临时库。
4. **方法引用 fallback**：无符号索引时点击方法引用自动打开所属类。
5. **wordAt 修复**：import 行点击只提取单个标识符（此前把整行当词）。

### 验证
- 集成测试新增：class_ref_extraction（同包 demo/Bar + Collections.emptyList + String.format 精确提取）、nested_archive_flow（Python 组装真实 BOOT-INF/lib fat jar 全链路）、navigate_cross_project_fallback
- cargo 185 通过；8 组集成测试全过；tsc/build/616 前端测试全过
