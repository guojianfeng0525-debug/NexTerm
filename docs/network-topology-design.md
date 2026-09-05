# 网络拓扑与网络诊断 — 架构设计

> 分支：`feature/network-topology`（基于 tag `v2.16.5`）
> 目标：在 NexTerm 已有的服务器连接 / SSH 会话 / 命令执行能力之上，新增「网络拓扑与网络诊断」功能。
> 面向 Windows 桌面端，**服务器端零安装**（只用系统自带命令，不做任何写入、不装 Agent）。

---

## 一、核心约束（不可违反）

| 约束 | 落地方式 |
|---|---|
| **只能手动触发** | 任何探测都必须由用户点击「探测当前服务器」按钮发起。组件挂载、服务器切换、应用启动**一律不得自动探测**。禁止 `useEffect` 中调用探测 API。 |
| **范围严格限定当前服务器** | 探测只针对 `activeConnection` 对应的那一台。不扫描局域网、不做 CIDR 邻居发现、不连接其他服务器。`ss -tunp` 抓到的对端 IP 仅用于**标记拓扑关系候选**，绝不主动连接。 |
| **不保存敏感认证信息** | 所有 `net_*` 表**禁止**出现 password / privateKey / passphrase / token 字段。节点只存 `connectionId`、`host` 等资产描述。代码评审时必须核对。 |
| **不保存无关终端内容** | 只持久化本功能定义的资产与拓扑数据，不落盘命令历史、终端输出正文。原始命令输出仅在内存中解析后即弃（可选保留截断的 `rawError` 用于排障，上限 2000 字符）。 |
| **自动 / 人工数据分离** | 每次重新探测**只能**覆盖自动采集字段，人工维护字段一旦被用户编辑过就必须原样保留。 |

---

## 二、总体架构

```
┌─────────────── 前端 ───────────────┐          ┌──────── Rust / Tauri ─────────┐
│  NetworkPanel (右侧栏「网络」tab)    │          │  probe_network_topology       │
│    · 绑定 activeConnection          │ invoke   │    · 取 ConnectionManager 会话 │
│    · 「探测当前服务器」按钮（手动）   │ ───────→ │    · 单脚本 exec（marker 分段） │
│    · 概览/接口/路由/防火墙/端口分栏   │          │    · 纯函数解析 → 结构化        │
│    · 「测试 TCP 连通性」按钮（手动）  │          │  probe_tcp_ports              │
│  ToolTopology (toolbox 全局拓扑视图) │ ───────→ │    · Windows 客户端 TcpStream  │
│    · 节点/连线 CRUD、隐藏、拖拽       │          │      connect + timeout        │
└──────────────┬─────────────────────┘          └──────────────────────────────┘
               │  src/lib/network/*
               ▼
      SQLite（9 张 net_* 表）+ 内存缓存
```

**两条入口，服务两种视角**：

1. **服务器维度** — 右侧栏 `Tabs` 新增 `network` tab，天然绑定 `activeConnection.connectionId`（= tab.id）。放「探测当前服务器」按钮与诊断详情。
2. **全局维度** — toolbox 新增 `topology` 工具视图，展示跨服务器合并后的拓扑图，支持节点 / 连线的增删改与布局调整。

---

## 三、数据模型（9 张表）

所有表通过 `src/lib/toolbox/db.ts` 的 `rowUpsert / rowList / rowGet / rowDelete` 访问，并在
`src-tauri/src/db.rs::TABLES` + `CREATE_SQL` 中同步定义（**数组长度需同步 +8**）。

字段标注：`A` = 自动采集（探测可覆盖） · `M` = 人工维护（探测**禁止**覆盖） · `S` = 系统字段

### 3.1 `net_nodes` — 服务器节点

| 列 | 标注 | 说明 |
|---|---|---|
| `id` | S | PK，探测时按 `connectionId` 复用 |
| `connection_id` | S | 关联的已保存连接 id（`originalConnectionId ?? tabId`），唯一业务键 |
| `hostname` | A | 探测得到的主机名 |
| `os_name` | A | 发行版 / 系统名 |
| `primary_ip` | A | 主 IPv4（默认路由出口网卡的地址） |
| `role_hint` | A | 依据监听端口推断的角色提示（web/db/cache/…），仅提示 |
| `display_name` | M | 用户改写的显示名（为空时回落到 `hostname`） |
| `node_type` | M | 服务器类型（物理机/虚拟机/容器/网关/数据库…） |
| `environment` | M | 环境（生产/预发/测试/开发） |
| `notes` | M | 备注 |
| `hidden` | M | 是否在拓扑图中隐藏 |
| `pos_x` / `pos_y` | M | 拓扑图人工布局坐标（NULL = 自动布局） |
| `last_probe_at` / `last_probe_status` | S | 最近探测时间与状态（`ok`/`partial`/`failed`） |
| `last_probe_error` | S | 最近一次失败原因（截断 2000 字符） |
| `created_at` / `updated_at` | S | 时间戳 |

### 3.2 `net_interfaces` — 网络接口

`id, node_id, iface_name(A), mac(A), state(A), mtu(A), is_loopback(A),
ipv4_addrs(A, JSON 数组), ipv6_addrs(A, JSON 数组), manual_label(M),
last_seen_at(S), missing_since(S), created_at(S)`
自然键：`node_id + iface_name`

### 3.3 `net_routes` — 路由表

`id, node_id, destination(A), gateway(A), genmask(A), flags(A), metric(A), iface(A),
route_type(A: default/unicast/link/local), manual_note(M), last_seen_at(S), missing_since(S)`
自然键：`node_id + destination + gateway + iface`

### 3.4 `net_firewalls` — 防火墙概览

`id, node_id, fw_type(A: firewalld/ufw/iptables/nftables/pf/none/unknown),
active(A), default_in_policy(A), default_out_policy(A), version(A),
zones(A, JSON), detect_note(A, 如 "permission denied" 降级说明),
manual_note(M), last_seen_at(S), missing_since(S)`
自然键：`node_id + fw_type`

### 3.5 `net_firewall_rules` — 防火墙规则

`id, node_id, firewall_id, table_name(A), chain(A), action(A), protocol(A),
src(A), dst(A), src_port(A), dst_port(A), in_iface(A), out_iface(A),
raw_rule(A), rule_hash(A, 自然键用), manual_purpose(M), last_seen_at(S), missing_since(S)`
自然键：`node_id + rule_hash`

### 3.6 `net_ports` — 监听端口

`id, node_id, protocol(A), port(A), listen_addr(A), state(A: listen/…),
process_name(A), pid(A), process_user(A), reachability(S, 见 §5),
service_name(M), purpose(M), hidden(M), last_seen_at(S), missing_since(S), created_at(S)`
自然键：`node_id + protocol + listen_addr + port`

### 3.7 `net_port_probes` — TCP 连通性探测结果

`id, node_id, port_id, protocol, port, target_host,
status(S: reachable/blocked/not_listening/unreachable/unexpected_open/dns_error/error),
tcp_ok(A), latency_ms(A), error_text(A, 截断), probed_at(S), triggered_by(S: manual)`

### 3.8 `net_links` — 拓扑连接关系

`id, source_node_id, target_node_id, protocol(A/M), port(A/M),
link_type(A: ssh/http/db/redis/…), status(A: active/observed/stale),
source(A: auto / manual), evidence(A, 自动推断依据，如 "ss ESTABLISHED 10.0.0.5:5432"),
description(M), manual_label(M), hidden(M),
first_seen_at(S), last_confirmed_at(S), created_at(S), updated_at(S)`
自然键：`source_node_id + target_node_id + protocol + port`

---

## 四、探测执行设计

### 4.1 单脚本、一次 exec（关键性能约束）

`ssh_execute_command` 底层 `execute_command` 持有 `RwLock` 读锁，且单条命令 30s 硬超时。
**禁止**串行调用 N 次。必须拼成一个 shell 脚本一次回传，用 marker 分段：

```
###NT:hostname###
<输出>
###NT:interfaces###
<输出>
###NT:routes###
...
```

分段顺序固定：`hostname` → `os` → `interfaces` → `routes` → `firewall` → `rules` → `ports` → `peers`
（`os` 复用 `OsInfo` 缓存，脚本内仍需回传以便解析降级）

每段内部再套 `2>/dev/null || echo "NT_ERROR:<原因>"`，保证任何一段失败都不影响其余段解析。

### 4.2 命令选择（distro-aware，参考 `os_detect.rs` 的 `impl OsInfo`）

| 段 | 首选 | 降级 |
|---|---|---|
| hostname | `hostname -f` | `hostname` / `uname -n` |
| interfaces | `ip -o addr` | `ifconfig -a` |
| routes | `ip route` | `netstat -rn` |
| firewall type | `systemctl is-active firewalld` / `ufw status` | `command -v nft` / `iptables -S` |
| rules | `firewall-cmd --list-all-ports` / `ufw status verbose` / `nft list ruleset` | `iptables -S` |
| ports | `ss -tulpnH` | `netstat -tulpn` |
| peers | `ss -tunpH state established` | `netstat -tnp` |

**只读保证**：全部为查询类命令，无重定向写入、无 `iptables -F/iptables -A` 等变更操作。
**零安装保证**：只用系统自带工具；工具缺失时该段标记 `unavailable` 而非失败。

### 4.3 无 root 的优雅降级

`iptables -L` / `ss -p` 在非 root 下常报 `Permission denied`。处理：
- 该段标记 `status: "partial"`，附 `detect_note: "需要 root 权限"`
- 其余段照常返回，整体 `last_probe_status = "partial"`
- UI 显式展示「部分数据需 root」徽标，不静默吞掉

### 4.4 后端接口契约

```rust
#[tauri::command]
async fn probe_network_topology(connection_id: &str, state) -> Result<ProbeResult, String>

struct ProbeResult {
    success: bool,
    error: Option<String>,          // 整体失败原因
    sections: ProbeSections,        // 分段状态：ok / partial / failed / unavailable
    data: ProbeData,                // 结构化数据
    probed_at_ms: u64,
    raw_excerpt: Option<String>,    // 排障用，截断 2000 字符
}

#[tauri::command]
async fn probe_tcp_ports(host: &str, ports: Vec<u16>, timeout_ms: u64)
    -> Result<Vec<TcpProbeResult>, String>
```

`TcpProbeResult { port, status, tcp_ok, latency_ms, error_text }`

---

## 五、TCP 连通性状态机（区分「监听 / 放行 / 可达」）

服务器侧是否监听（`net_ports`）与客户端 TCP 结果（`net_port_probes`）交叉判定：

| 端口监听 | TCP 结果 | `status` | 用户可读结论 |
|---|---|---|---|
| 是 | 连接成功 | `reachable` | 已监听、防火墙已放行、网络可达 |
| 是 | RST / 拒绝 | `not_listening` | 探测信息已过期，端口实际未监听 |
| 是 | 超时 | `blocked` | 已监听，但被防火墙或网络策略拦截 |
| 否 | 连接成功 | `unexpected_open` | 服务器未报告监听，但客户端可连（值得关注） |
| 否 | 超时 | `unreachable` | 端口不可达 |
| — | DNS 失败 | `dns_error` | 主机名无法解析 |

实现：`tokio::time::timeout(Duration::from_millis(n), TcpStream::connect((host, port)))`
（照 `src-tauri/src/proxy.rs:78-101` 的写法；`tokio` 已带 `full` features，无需新增依赖）。
批量端口用 `futures::future::join_all` 并发，并发上限 32。

**TCP 探测是独立的手工动作** — 探测流程本身不自动发起对外连接，需用户点击「测试 TCP 连通性」。

---

## 六、增量合并策略（自动 / 人工字段分离）

`src/lib/network/topology-merge.ts` 的核心语义，针对每张明细表：

```
merge(existing[], detected[], probeAt):
  按 naturalKey 建立索引
  ├─ 命中   → 仅覆盖 A 字段；M 字段原样保留；last_seen_at = probeAt；missing_since = null
  ├─ 新增   → 插入，M 字段为默认值；last_seen_at = probeAt
  └─ 消失   → 不删除。若 missing_since 为空则置为 probeAt（保留人工标注，UI 标灰显示「本次未探测到」）
```

要点：
- **绝不整行覆盖**。合并函数逐字段挑选，只写白名单内的 A 字段。
- **消失项不删除**，避免用户人工标注（如端口用途）随探测丢失。UI 提供「清理长期缺失项」的显式入口。
- `updated_at` 只在 A 字段实际变化时刷新，避免无意义写盘。

---

## 七、全局拓扑的合并与推断

用户依次探测不同服务器时：

1. 每台服务器探测 → upsert 一个 `net_nodes`（按 `connectionId` 定位）
2. 从该服务器的 `peers` 段拿到 ESTABLISHED 连接的对端 IP:PORT
3. 若对端 IP 命中**已探测过的另一个节点**的接口地址 → 生成 / 确认一条 `net_links`
   （`source=auto`，`evidence` 记录依据，如 `ss ESTABLISHED 10.0.0.5:5432`）
4. 未命中的对端 IP → **丢弃**（不建节点，不扫描，符合「范围限定」约束）
5. 用户可手工新增 / 编辑 / 删除 / 隐藏任意节点与连线（`source=manual`）

自动推断的连线只**补充**信息，不覆盖手工关系的 `description` / `manual_label`。

---

## 八、文件边界（严格按文件划分，禁止跨写）

| 责任人 | 独占文件 |
|---|---|
| **rust-dev** | `src-tauri/src/network_probe.rs`（新）、`src-tauri/src/db.rs`、`src-tauri/src/lib.rs`、`src-tauri/src/os_detect.rs` |
| **fe-data** | `src/lib/network/topology-types.ts`、`topology-storage.ts`、`topology-merge.ts`、`topology-api.ts`、`src/lib/network/__tests__/*`、`src/lib/toolbox/db.ts` |
| **fe-panel** | `src/components/network/network-panel.tsx`、`node-summary.tsx`、`interface-table.tsx`、`route-table.tsx`、`firewall-view.tsx`、`port-table.tsx` |
| **fe-graph** | `src/components/toolbox/tool-topology.tsx`、`src/components/network/topology-graph.tsx`、`topology-node-dialog.tsx`、`link-editor-dialog.tsx` |
| **CTO（集成）** | `src/App.tsx`、`src/components/toolbox/toolbox-nav.tsx`、`toolbox-types.ts`、`menu-bar.tsx`、`src/locales/*.json`、`src/lib/i18n.ts` |

**`src-tauri/src/commands.rs` 由 rust-dev 独占**（仅尾部追加命令，不改动既有内容）。

---

## 九、持久化安全清单

- [ ] 9 张 `net_*` 表无任何认证字段（password / key / token / passphrase）
- [ ] 节点只存 `connectionId` 引用，不复制连接配置的凭据部分
- [ ] `raw_excerpt` / `error` 一律截断 2000 字符，且不含 `sudo` 回显的敏感内容
- [ ] 探测脚本只读，无 `>` 重定向、无包管理、无服务变更命令

---

## 十、验收要点

1. 未点击「探测当前服务器」时，进入服务器不产生任何网络探测调用
2. 探测范围仅当前服务器：抓包/日志中不得出现对其他服务器或网段的主动连接
3. 二次探测后，用户手工修改的服务器名称、端口用途、备注**保持不变**
4. 二次探测后，自动采集字段（如新出现的监听端口）正确增量更新
5. TCP 连通性测试能区分「监听但被拦截」与「未监听」
6. 依次探测多台服务器后，拓扑图逐步合并出跨服务器关系
7. 全部通过：`pnpm test`、`cargo test`、`tsc`、`pnpm lint`、`pnpm i18n:check`

---

## 十一、端口拓扑扩展（二级下钻）

端口拓扑复用服务器节点、接口、防火墙、监听端口、探测流程和 SQLite 持久化层，只新增 `net_port_links` 与前端二级视图，不改变服务器级 `net_links` 的数据结构和交互。

### 11.1 身份与方向

- 端口对象自然键包含 `node_id + protocol + listen_addr + port`。`10.10.1.20:8080/tcp` 与 `10.10.1.21:8080/tcp` 是不同节点，绝不按裸端口号合并。
- 端口连接的自然键是“源端点 + 源协议/端口 + 目标端点 + 目标协议/端口”。源或目标端点可以是已探测服务器 ID，也可以是尚未探测的 IP。
- `ss/netstat` 的方向按 socket 形态推断：本地监听端口为服务端，记录 `远端:远端端口 → 本地:监听端口`；本地临时端口为客户端，只有能通过 PID/进程名映射到同一进程的稳定监听端口时，才记录 `本地服务端口 → 远端服务端口`，不把临时端口伪装成业务端口。
- 未探测 IP 只作为 `IP:port` 未知端点保存，不自动探测、不创建节点。用户之后主动探测该服务器时，仅用已保存接口地址做本地关联并回填节点/端口 ID。

### 11.2 状态与人工数据

端口视图同时展示监听状态、监听地址、防火墙规则结论、客户端 TCP 可达性、实际连接状态和最近时间。四类状态分别判定：`127.0.0.1` 监听不代表外部可达，防火墙允许不代表实际可连，TCP 可达也不等同于存在业务连接。

重新探测只刷新端口与连接的自动字段；端口服务名、用途、备注、标签，以及连接说明 / 标签 / 隐藏状态均由用户维护且不会被覆盖。用户可新增、编辑、删除入站或出站端口连接，用于补充探测无法识别的业务关系。
