# JAR 反编译编辑模块 — 技术设计（Phase 2）

## 1. 架构决策（经用户确认）

| 决策点 | 结论 |
|---|---|
| 后端架构 | **Tauri command 替代 Axum**。单进程本地运行，Rust 层即本地后端 |
| 编辑器 | **现有 CodeMirror 6**（已支持 Java 高亮/折叠/搜索/行号），不引入 Monaco |
| 反编译器 | **jd-core 1.1.3**（JD-GUI 1.6.6 的官方引擎，捆绑为 jdcore-wrapper.jar 随应用分发）+ 自动探测 javac/JAVA_HOME |
| 数据存储 | SQLite（项目/类/源码/历史），原始 JAR 只读，永不入库 |

## 2. 整体架构

```
React (CodeMirror 6)
 ├── ToolJarDecompiler 组件（toolbox 新视图 'jar'）
 ├── JAR 拖拽/选择 → invoke('jar_project_open')
 ├── Package/Class 树 ← jar_class_list / jar_class_index
 ├── 编辑器 ← jar_class_source (原始) / jar_class_modified (用户)
 ├── 保存 → jar_class_save / jar_history_create
 ├── 编译 → jar_compile
 ├── 构建 → jar_build
 └── 恢复 → jar_class_revert / jar_project_reset
        │
        ▼ invoke (async + spawn_blocking)
Rust
 ├── jar.rs — ZIP/JAR 解析、Class 索引、资源提取
 ├── decompile.rs — jd-core 调用（java -jar jdcore-wrapper.jar，Printer 忠实移植 JD-GUI StringBuilderPrinter）、按需反编译
 ├── compile.rs — javac 探测、编译、错误解析
 ├── builder.rs — JAR 重建（原始 JAR + 修改 Class 合并）
 ├── jar_db.rs — SQLite 表 + 项目状态
 └── lib.rs — 注册 commands
        │
        ▼
SQLite (jar_projects, jar_classes, jar_versions)
```

## 3. 数据模型（SQLite）

```sql
-- 一个 JAR 项目（打开一次 = 一个项目）
CREATE TABLE IF NOT EXISTS jar_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,            -- JAR 文件名
  jar_path TEXT NOT NULL,        -- 原始 JAR 绝对路径（只读输入）
  jar_hash TEXT NOT NULL,        -- SHA-256，检测 JAR 是否变化
  size INTEGER NOT NULL,
  class_count INTEGER NOT NULL DEFAULT 0,
  resource_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 每个 Class / 资源条目（从 JAR 索引）
CREATE TABLE IF NOT EXISTS jar_classes (
  id TEXT PRIMARY KEY,           -- "projId:path"
  project_id TEXT NOT NULL REFERENCES jar_projects(id) ON DELETE CASCADE,
  entry_path TEXT NOT NULL,      -- 如 com/example/Foo.class
  class_name TEXT NOT NULL,      -- 完整类名 com.example.Foo
  package_name TEXT NOT NULL,    -- com.example
  kind TEXT NOT NULL DEFAULT 'class', -- class | resource | meta-inf
  is_inner_class INTEGER NOT NULL DEFAULT 0,
  original_decompiled TEXT,      -- 反编译原始结果（懒生成，JD-GUI 语义不缓存）
  modified_source TEXT,          -- 用户修改后的源码（NULL = 未修改）
  modified INTEGER NOT NULL DEFAULT 0,
  compile_status TEXT NOT NULL DEFAULT 'none', -- none|ok|error|stale
  compile_output TEXT,           -- 编译错误/警告文本
  compile_timestamp INTEGER,
  source_hash TEXT,              -- 修改源码哈希（检测变化）
  UNIQUE(project_id, entry_path)
);

-- 版本历史（每次保存修改产生一条）
CREATE TABLE IF NOT EXISTS jar_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  class_id TEXT NOT NULL REFERENCES jar_classes(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  source TEXT NOT NULL,          -- 该版本的源码快照
  compiled_bytes BLOB,           -- 编译成功的 .class 字节（可为空）
  compile_status TEXT NOT NULL,
  compile_output TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(class_id, version)
);

-- 构建历史
CREATE TABLE IF NOT EXISTS jar_builds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES jar_projects(id) ON DELETE CASCADE,
  output_path TEXT NOT NULL,
  built_at INTEGER NOT NULL,
  result TEXT NOT NULL,          -- ok | error
  detail TEXT
);
```

**数据原则**：
- 原始 JAR **永不入库**（jar_path 指向原文件，只读）
- 原始反编译源码（original_decompiled）与用户修改（modified_source）**分离存储**
- 编译成功的 .class 字节存 jar_versions.compiled_bytes（小，可接受）
- 删除项目时级联删除（不删原始 JAR）

## 4. API 设计（Tauri commands，全部 async）

### 项目生命周期
| command | 说明 |
|---|---|
| `jar_project_open { path }` | 打开 JAR：校验、索引、建项目。返回 ProjectSummary |
| `jar_project_list` | 列出历史项目 |
| `jar_project_close { projectId }` | 关闭项目（保留 SQLite 状态） |
| `jar_project_delete { projectId }` | 删除项目记录（不删 JAR） |

### 浏览
| command | 说明 |
|---|---|
| `jar_class_index { projectId }` | 返回 Package→Class 树（含资源/内部类标记） |
| `jar_class_info { projectId, entryPath }` | 单类元信息（包、类名、内部类、大小） |
| `jar_class_search { projectId, query }` | 按类名/方法/字段搜索（索引时预解析签名） |
| `jar_resource_read { projectId, entryPath }` | 读资源文本（如 .properties/.xml/.json） |

### 反编译（按需 + 缓存）
| command | 说明 |
|---|---|
| `jar_decompile { projectId, entryPath }` | 按需反编译（JD-GUI 语义：每次重新反编译，不缓存）并返回 ClassView |
| `jar_decompile_cancel { projectId }` | 取消进行中的反编译 |

### 编辑/保存
| command | 说明 |
|---|---|
| `jar_class_source { projectId, entryPath }` | 返回当前应显示源码（优先修改版，否则原始版） |
| `jar_class_save { projectId, entryPath, source }` | 保存修改 + 写版本历史 + 标 modified |
| `jar_class_revert { projectId, entryPath, version? }` | 恢复当前类（指定版本或原始） |
| `jar_project_reset { projectId }` | 恢复全部修改 |

### 编译
| command | 说明 |
|---|---|
| `jar_jdk_detect` | 探测 javac/JAVA_HOME，返回版本/路径 |
| `jar_compile { projectId, entryPath? }` | 编译单个类或全部修改类。返回错误列表 |
| `jar_compile_cancel { projectId }` | 取消编译 |

### 构建
| command | 说明 |
|---|---|
| `jar_build { projectId, outputPath }` | 重建 JAR：原始 JAR + 修改/新增 Class + 保留资源/META-INF |
| `jar_build_cancel { projectId }` | 取消构建 |

## 5. JAR 解析设计

- 用 `zip` crate 读 entries，**不全部解压到内存**（大 JAR）
- 索引时只读 entry 元数据（name/size/compressed），Class 字节按需读
- 分类：`.class` → class；`META-INF/**` → meta-inf；其余 → resource
- `$` 后缀判定内部类（`Foo$Bar.class`）
- 懒读取：反编译/资源读取时才从原始 JAR 解压对应 entry

## 6. 反编译流程（jd-core，JD-GUI 引擎）

1. 用户点击 Class → `jar_decompile`
2. 用户已修改？→ 直接返回修改源码；否则重新反编译（JD-GUI 语义：无缓存，按需生成）
3. 从原始 JAR 读该 entry 字节 → 写临时 .class 文件 → `java -jar jdcore-wrapper.jar <class> --internal-name <name> --classpath <siblings>` → stdout 输出
4. 兄弟类（同目录/内部类）按包结构解到临时 siblings 目录（JD-GUI ContainerLoader 语义），供 jd-core 解析
5. 反编译失败（非法 class / java 缺失）→ 明确错误信息

**调用方式**：子进程 `java -Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -jar <bundled jdcore-wrapper.jar> <class文件>`。wrapper 的 Printer 忠实移植 JD-GUI 的 StringBuilderPrinter / LineNumberStringBuilderPrinter（TAB=两空格、unicodeEscape 默认关、saver 模式 `/* n */ ` 行号前缀）。

**取消**：反编译任务 spawn_blocking + 轮询 cancel 标志，杀子进程（unix SIGKILL / windows taskkill）。

## 7. 编译流程（javac）

1. `jar_jdk_detect`：`javac -version` / `$JAVA_HOME/bin/javac` 探测
2. 编译单个类：写修改源码到临时目录（保留包结构）→ `javac -d out <pkg>/<Class>.java`
3. 编译全部：所有 modified 类一起编译（处理类间依赖）
4. 解析 javac stderr → 错误列表（文件/行/列/消息）→ 返回前端 Problems 面板
5. 成功：读生成的 .class → 存 `jar_versions.compiled_bytes` → compile_status=ok
6. 失败：compile_status=error，**不覆盖**已有成功版本
7. 依赖类：仅编译修改类；被修改类引用的其他类用原始 JAR 的 classpath（`-classpath original.jar`）

## 8. JAR 构建流程

1. 读原始 JAR entries（zip crate）
2. 对每个 entry：
   - 未被修改/删除的 class → **原样复制字节**（保持压缩方式和结构）
   - 被修改且编译成功的 class → 用编译产物字节替换
   - 被删除的 class → 跳过
   - 新增 class → 追加（编译产物）
   - 资源 / META-INF → 原样复制
3. 写出新 JAR 到用户指定路径
4. **原始 JAR 只读**：构建只读原文件，绝不写回
5. 构建期间记录日志；失败不破坏 SQLite（先写临时文件，成功再 rename）

## 9. 前端 UI（Phase 3 细化）

```
Toolbar: [打开JAR] [JDK: 17.0.18] [构建] [恢复全部]
┌────────────┬─────────────────────────────┐
│ JAR Tree   │ Java Editor (CodeMirror 6)  │
│ Package    │  • 语法高亮/折叠/搜索/替换  │
│  └ Class   │  • 修改状态标记             │
│ Resources  │  • Diff 视图（原始/修改）   │
│ META-INF   │                            │
├────────────┴─────────────────────────────┤
│ Problems / Output / Build / Search       │
└──────────────────────────────────────────┘
```

状态显示：当前 JAR / 当前 Class / 修改状态 / 保存状态 / 编译状态 / JDK / 构建状态。

## 10. 测试计划（Phase 5）

- 空 JAR / 单 Class / 多层包 / 内部类 / 匿名类 / 混淆类 / 多版本 class
- 修改→保存→恢复 / 编译成功 / 编译失败 / 新增/删除/替换 Class
- JAR 重建字节级对比（未修改部分一致）/ 原始 JAR 未被修改
- 单元：JAR 解析、索引分类、反编译调用、javac 错误解析、构建合并
- 集成：用真实编译出的 class 做 round-trip

## 11. 实施顺序

Phase 3 UI 骨架 → Phase 4: jar.rs 解析 → jar_db.rs → decompile.rs → compile.rs → builder.rs → commands 注册 → 前端接线 → Phase 5 测试。
