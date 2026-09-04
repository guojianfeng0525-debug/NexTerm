# 网络拓扑与网络诊断 — 交付说明

- **分支**：`feature/network-topology`（基于 tag `v2.16.5`，commit `366bbb6`）
- **提交**：`d4105f2` — `feat(network): add network topology and diagnostics module`
- **规模**：35 个文件，+13,384 行，**零新增依赖**
- **日期**：2026-09-04

---

## 一、功能落点

两个入口，服务两种视角：

| 入口 | 位置 | 用途 |
|---|---|---|
| **服务器维度** | 右侧栏新增「网络」标签页 | 绑定当前连接的服务器，执行探测、查看诊断详情 |
| **全局维度** | 工具箱新增「网络拓扑」 | 跨服务器的拓扑图，节点/连线增删改与布局 |

「进入某一台服务器 → 右侧栏切到「网络」→ 点击「探测当前服务器」」是主路径。

---

## 二、核心约束如何被满足

| 你的要求 | 实现方式 | 验证方式 |
|---|---|---|
| 只能手动点击触发，绝不自动探测 | 探测 API 唯一调用点在 `handleProbe` 点击处理器内 | 全项目 grep 确认唯一调用点；3 个 `useEffect` 分别只做刷新时间标签、本地存储读取、订阅变更 |
| 范围严格限定当前服务器，不扫描局域网 | 对端 IP 只有命中**已探测过的节点**才建关系，否则丢弃 | 单测硬断言「未知对端不建节点也不建链」「解析回自身节点的对端被忽略」 |
| 服务器端零安装 | 只用 `ip` / `ss` / `iptables` / `nft` / `firewall-cmd` / `ufw` / `hostname` 等系统自带命令 | 工具缺失时该段标 `unavailable`，不失败不中断 |
| 区分监听 / 放行 / 实际可达 | 服务器监听状态 × 客户端 TCP 结果交叉判定，6 种结论 | 表驱动单测覆盖全部 6 条分支 |
| 增量保存，不覆盖人工修改 | 按自然键合并，**白名单拷贝**只写自动字段；自动/人工字段冲突时 fail-fast | 12 个回归用例，含「负载携带人工键也不得覆盖」 |
| 消失的条目不丢数据 | 不删除，只标记 `missingSince`，界面置灰显示「本次未探测到」 | 单测覆盖「消失→再现」的 `missingSince` 清空语义 |
| 不保存密码/私钥 | 8 张 `net_*` 表无任何认证字段，节点仅存 `connectionId` | 建表语句与前端行映射双向扫描，凭据字段 0 命中 |

---

## 三、技术实现要点

### 探测执行：单脚本一次 exec

`ssh_execute_command` 底层持有 SSH 会话读锁，且单条命令有 30 秒超时。串行执行 8 条命令最坏要 240 秒且长期占锁。

因此探测命令被拼成**一个 shell 脚本一次下发**，用 `###NT:<section>###` 标记分段，在 Rust 侧按标记切分解析。任一段失败只影响该段，其余照常返回。

### 无 root / 工具缺失的降级

`iptables -L`、`ss -p` 在非 root 下常报 `Permission denied`。这类情况不判为失败，而是该段标记 `partial` 并在界面显示提示（如「防火墙：需要 root 权限」），其余数据正常入库。

### 数据模型：8 张表

`net_nodes` / `net_interfaces` / `net_routes` / `net_firewalls` / `net_firewall_rules` / `net_ports` / `net_port_probes` / `net_links`

每张表的字段都在 `src/lib/network/topology-types.ts` 里被划分为 **A（自动采集）** / **M（人工维护）** / **S（系统）** 三类，合并引擎只写 A 类——这是「重探不覆盖人工修改」的执行依据。

### 拓扑图：自绘 SVG，零依赖

项目原本没有任何拓扑图库（只有 recharts，不适合画拓扑）。考虑到节点规模通常小于 50，且要避免新增依赖和 Windows 兼容风险，采用原生 SVG + React 实现节点卡片、连线、拖拽、缩放平移。

---

## 四、验证结果

| 项目 | 结果 |
|---|---|
| TypeScript 全量类型检查 | **0 错误** |
| ESLint 全量 | **0 error**（260 warnings 全在既有代码） |
| 前端单测 | **1196 通过 / 124 文件**（本次新增 92） |
| Rust 单测 | **387 通过**（本次新增 50 个解析器测试） |
| i18n 中英 parity | **2508 键通过**（本次新增 280 个键：network 140 + topology 140） |
| 依赖变更 | 无（Cargo.lock / package.json 均未改动） |

Rust 侧还在真实 Linux 主机上跑通了完整探测：8 段全部 ok，解析出 7 个网卡、2 条路由、14 条 UFW 规则、11 个监听端口、17 条 ESTABLISHED 连接。
（该结果为开发侧自测记录，未经二次独立复核。）

---

## 五、待办与建议

1. **未做真实页面 E2E 验证**。本轮完成了单元测试与类型/静态检查，但按照项目发布门禁，功能标记完成前应在真实应用里跑一遍 E2E（WDIO + debug 二进制 + 真实服务器 fixture），并截图做视觉评审。这需要可用的测试服务器，请提供后我再补。
2. **版本号未 bump**，CHANGELOG 记在 `[Unreleased]` 段。需要发布时我可以按手动流程升到 `2.17.0`（改 `package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` 四处 + `cargo check` 验证），并打 tag。
3. 当前**未推送到远程**，分支停留在本地。需要的话我来 push。

---

## 六、主要文件

| 路径 | 说明 |
|---|---|
| `docs/network-topology-design.md` | 架构设计契约（数据模型、字段归属、合并策略、状态机） |
| `src-tauri/src/network_probe.rs` | Rust 探测引擎：脚本生成 + 8 段解析 + 50 个单测 |
| `src-tauri/src/os_detect.rs` | 追加 9 个发行版感知的命令生成函数 |
| `src/lib/network/topology-types.ts` | 类型契约，字段 A/M/S 归属的唯一真相源 |
| `src/lib/network/topology-merge.ts` | 增量合并引擎，自动/人工字段分离的执行者 |
| `src/lib/network/topology-storage.ts` | SQLite 持久化 + 内存缓存 |
| `src/components/network/network-panel.tsx` | 服务器维度诊断面板 |
| `src/components/toolbox/tool-topology.tsx` | 全局拓扑视图 |
| `src/components/network/topology-graph.tsx` | 自绘 SVG 拓扑图 |
