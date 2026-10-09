# Claude HUD — 设计文档 v0.1

> 目标设备：ESP32-C3 SuperMini + ST7789 240x240(接线见 `D:\Claude DIY\接线.xlsx`)
> 当前串口：COM7
> 本文档是写代码前的架构基线，所有实现按此执行。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 做网站还是做软件 | **做桌面软件(Electron + React)**。网站无法开机自启、无法常驻 BLE、无法写 `settings.json`。将来可让 daemon 顺带开一个局域网只读看板，几乎零成本。 |
| 表情替换要不要重新烧录 | **不要**。经核实 `esptool-js` 走的是 **Web Serial(USB 串口)**，不是 BLE，拔掉线就无法使用。所以"免接线换表情"只能靠**BLE 数据协议 + 设备端持久化存储**实现，烧录只用于首次刷固件。 |
| cc-switch 切供应商会冲掉 hook | **会**。必须由常驻进程监听 `~/.claude/settings.json` 并在被覆盖后 300ms 内重新注入(见 §4.4)。首选方案是写企业级 `managed-settings.json` 做到免疫，P1 验证其可行性。 |
| 主链路用什么传输 | **只用 BLE**。串口仅用于首次烧录和调试日志，绝不作为运行时通道(会被 Arduino 串口监视器 / 烧录工具抢占)。 |
| 谁来持有 BLE 连接 | **daemon 独占**。Windows 同一外设只允许一个 central 连接，UI 与 hook 都不得直连 BLE。 |

---

## 1. 需求还原

### 1.1 你真正要的三件事

1. **看得见**：设备一上电，屏幕上和电脑上都能看到"BLE 连没连上"。现在重启后抓瞎，是因为固件只在串口 `Serial.println` 里报连接状态，屏幕上没有任何指示。
2. **连得住**：一个常驻进程，设备上电自动连、断了自动重连、电脑休眠唤醒后自动恢复。
3. **跟着 Claude 动**：Claude Code 的 hook 事件(提交提示、调工具、工具结束、回答完成、等待确认)实时驱动屏幕表情。

### 1.2 三个组件的角色(对应你说的"地基三点")

| 你的说法 | 准确的角色 | 说明 |
|---|---|---|
| "先连接 ESP" | **BLE Link** | 由 daemon 持有，负责扫描/连接/重连/心跳/MTU 协商 |
| "demon 负责转码，需要启动命令" | **Daemon** | 常驻后台服务。它做三件事：持有 BLE、接收 hook 事件、管理表情库。它还需要一个**开机自启**，不只是"启动命令" |
| "写 hook 代码到 settings.json" | **Config Injector** | 注入 + 监视 + 被覆盖后自动重注入。这是全项目最容易翻车的一环 |

### 1.3 hook 的生命周期(关键认知)

hook 是**短命进程**：Claude Code 每次触发事件时 `spawn` 一个进程，喂 JSON 到 stdin，等它退出，超时就杀。它不能持有 BLE 连接——每次连 BLE 在 Windows 上要 1~3 秒，且会与 daemon 抢连接。

正确形态：

Claude Code ──spawn+stdin JSON──> hook shim(3~150ms，只做一次 socket 写)
                                        | 本地 localhost:17321，一行 JSON
                                        ▼
                                     Daemon(常驻，独占 BLE)
                                        | BLE GATT write
                                        ▼
                                    ESP32-C3 屏幕


这就是"hook 瞬时、daemon 常驻"的正确落地方式。

### 1.4 关于 `uk0/cc_hud_esp32` 的参考价值

已核实该项目：
- 注册了 **5 个 hook**：`UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop` / `Notification`。这 5 个就是你说的"五个 hook 协议"，可以直接沿用。
- 传输方式：hook 脚本 `cchud-hook.sh` **自己**用 `bleak` 连 BLE 推 `msg_type 0x07`，并用 `mkdir` 锁做"单飞"防并发。
- 状态语义：`idle / thinking / tool / waiting`。

**可沿用的**：hook 事件集合、状态枚举、去重/防抖思路。
**不能照抄的**：让每个 hook 自己连 BLE。它是在 macOS 上用 CoreBluetooth 单连接限制下打的补丁；Windows 上连接更慢、更不稳，必须改成常驻 daemon + 本地 IPC。它的 BLE service UUID 也和我们现有固件不同，不要混用。

---

## 2. 做网站还是做软件

**结论：做桌面软件。** 理由逐条对应你的需求：

| 需求 | 浏览器网站 | 桌面软件 |
|---|---|---|
| 开机自启、后台常驻 | ✗ | ✓ |
| 常驻 BLE 连接(无需用户手势、关标签页不断) | ✗ Web Bluetooth 要求用户手势 + 页面存活 | ✓ |
| 写 `~/.claude/settings.json` | ✗ | ✓ |
| 文件监视 cc-switch 覆盖 | ✗ | ✓ |
| 通过 Web Serial 首次烧录固件 | ✓(Chrome/Edge) | ✓(Electron 支持 Web Serial) |
| 启停/守护 daemon 子进程 | ✗ | ✓ |
| 系统托盘 + 气泡通知 | ✗ | ✓ |

**所以：一个 Electron 桌面应用**，UI 全部用 Web 技术写。这样你"想做成网站"的直觉没有浪费——UI 代码本来就是网页，P2 阶段让 daemon 多监听一个局域网端口，就是手机可看的只读看板。

---

## 3. 两个必须纠正的技术前提

### 3.1 `esptool-js` 不能走 BLE

`esptool-js` 基于 **Web Serial API**(`navigator.serial.requestPort()`)，必须用 **USB 串口线**。仓库中没有任何 Bluetooth transport。Chrome on Android 也是靠 Web Serial polyfill，同样要有线。

因此：
- ✅ 首次烧录：应用内嵌 esptool-js + Web Serial，插一次 COM7 完成烧录，用户不需要装 Arduino IDE。这是它真正的价值。
- ❌ "BLE 连接后免接线替换表情"：**做不到通过 esptool-js 实现**。
- ✅ 正确做法：表情**不是固件**，是**数据**。固件里实现一套 BLE 表情下发协议 + 设备端存储(NVS / LittleFS)，表情定义在运行时通过 BLE 传进去并落盘。换表情 = 传数据，永不再烧录。

这一步想通了，整个项目的天花板就打开了。

### 3.2 cc-switch 一定会冲掉你的 hook

已核实：
- `C:\Users\wyy12\.cc-switch\cc-switch.db`(5.8MB，供应商与配置的权威存储)
- `C:\Users\wyy12\.claude\settings.json` 当前内容是 cc-switch 托管产物(`ANTHROPIC_AUTH_TOKEN: "PROXY_MANAGED"`、`ANTHROPIC_BASE_URL: http://127.0.0.1:15723`)，**且不含 `hooks` 字段**。

切换供应商 = cc-switch 用 db 里的配置整体覆写 `~/.claude/settings.json`，我们的 `hooks` 随之消失。三层防御，按优先级：

1. **首选(免疫)**：写入企业级托管配置 `C:\ProgramData\ClaudeCode\managed-settings.json`。托管配置优先级最高且 cc-switch 不碰它。**需 P1 实测** Claude Code 在 Windows 上是否读取该路径、以及是否需要管理员权限。
2. **保底(一定可行)**：常驻文件监视器。监听 `~/.claude/settings.json` 变更 → 300ms 防抖 → 剔除并重新合并我们的 hook → 原子写回。cc-switch 覆盖后最多 300ms 内自动恢复。
3. **辅助**：`install.ps1` 一键安装 / 卸载，提供手动"立即修复"按钮。

第 2 条是必须实现的，因为第 1 条有不确定性。

**注入算法(必须带哨兵标记，否则会污染用户配置)：**

SENTINEL = "cchud"

on settings.json changed (debounce 300ms, ignore self-write by hash):
    for attempt in 1..5:                      # cc-switch 写入可能不是原子的
        try: cfg = json.load(settings.json); break
        except JSONDecodeError: sleep 100ms
    else: return                               # 放弃本轮，等下个事件
    # 1. 清除旧注入：遍历 cfg["hooks"][*][*]["hooks"][*]["command"]
    #    凡包含 SENTINEL 的条目一律移除；空数组则删除该事件键
    # 2. 若未启用 → 只做清理后写回
    # 3. 合并我们的 5 个事件(保留用户已有的其他 hook)
    # 4. 若内容无变化 → 不写(避免触发监视循环)
    # 5. 备份到 %APPDATA%\ClaudeHUD\backups\settings-<ts>.json
    # 6. 原子写：写 settings.json.tmp → os.replace()


**注意**：现在 `settings.json` 里有 `"permissions": {"bypassPermissions": true}`，注入器绝不能碰除 `hooks` 之外的任何字段。

---

## 4. 总体架构

### 4.1 组件图

┌────────────────────────────────────────────────────────────────┐
|  Electron 桌面应用 (UI)                                         |
|  ┌───────────────┬────────────────┬──────────────────────────┐ |
|  | 连接状态面板   | 表情编辑器      | 日志 / 设置 / 托盘        | |
|  └───────────────┴────────────────┴──────────────────────────┘ |
|  主进程职责：托盘、开机自启、spawn/守护 daemon、Web Serial(烧录)  |
└───────────────┬────────────────────────────────────────────────┘
                | WebSocket ws://127.0.0.1:17321/ws  +  REST
┌───────────────▼────────────────────────────────────────────────┐
|  Daemon  (Python · asyncio · bleak)  — 常驻，唯一持有 BLE        |
|  ┌──────────┬──────────┬───────────┬──────────┬─────────────┐  |
|  | ble_link | protocol | state_map | expr lib | settings    |  |
|  | 连接/重连 | 帧编解码 | 事件→状态 | 表情库   | injector    |  |
|  └──────────┴──────────┴───────────┴──────────┴─────────────┘  |
└───────┬──────────────────────────────────────┬─────────────────┘
        | BLE GATT (唯一 central)               | localhost:17321
┌───────▼──────────────┐              ┌────────▼─────────────────┐
|  ESP32-C3 + ST7789   |              |  hook shim (编译型小 exe) |
|  NimBLE + 表情引擎    |              |  ← Claude Code spawn     |
|  NVS/LittleFS 持久化  |              └──────────────────────────┘
└──────────────────────┘                          ▲
                                        ┌─────────┴──────────┐
                                        | Claude Code hooks  |
                                        | (被 injector 写入)  |
                                        └────────────────────┘


### 4.2 启动时序(应用冷启动)

1. Electron 主进程启动
2. 检查 daemon 是否在跑(尝试连 17321)；不在则 spawn daemon(sidecar)
3. daemon 初始化：
   a. 加载 %APPDATA%\ClaudeHUD\config.json
   b. 加载表情库(expressions/*.json)
   c. settings_injector.start()  ← 立即注入 hook 并启动监视
   d. ble_link.start()           ← 开始扫描 "Claude-HUD"
4. 扫描到设备 → 连接 → 协商 MTU(512) → 订阅 TX 通知 → 握手(PING/PONG)
5. 握手返回固件版本；版本不匹配则 UI 提示需要烧录
6. 同步表情库：对比设备端 slot 指纹，差异项下发
7. 进入稳态：心跳 5s，状态变更即时推送


### 4.3 运行时数据流

Claude Code 事件
  → hook shim(读 stdin JSON，取 hook_event_name + tool_name)
  → 一行 JSON 写 localhost:17321
  → daemon.state_map 映射：UserPromptSubmit→THINKING，PreToolUse→TOOL_START，
    PostToolUse→TOOL_END(1s后回落 THINKING)，Stop→IDLE，Notification→WAITING
  → 去重/节流(同状态 200ms 内合并；TOOL_END 是瞬态，带 auto-revert)
  → protocol.encode(STATE)
  → BLE write(write-without-response 优先，失败降级 write-with-response)
  → 固件解析 → 状态机 → 非阻塞动画渲染
  → 固件回 ACK/STATUS(notify)→ daemon → UI 状态面板


### 4.4 表情更新流(免烧录的核心)

UI 编辑器(Canvas 240x240 实时预览)
  → PUT /expressions/{id}  → daemon 落盘 expressions/{id}.json
  → POST /device/push/{id} → 分片传输：
       EXPR_BEGIN(总长, CRC16, slot)
       EXPR_CHUNK(offset, data) × N     ← 每片 ≤ MTU-8，带 20ms 间隔
       EXPR_COMMIT(slot)                ← 固件校验 CRC16 后写入 NVS/LittleFS
  → 固件回 ACK；失败自动重传该片(最多 3 次)
  → EXPR_SELECT(state, slot)             ← 绑定"状态→表情"
  → 设备断电重启后从 NVS 恢复，无需重传


### 4.5 开机动画流(编译进固件 + BLE 可覆盖)

logo 数据源：`F:\桌宠代码\clawd-mochi\clawd_mochi\clawd_mochi.ino` 的两张
PROGMEM 表(LOGO_SEGS 162 段 / LOGO_TRIS 162 三角形)，一次性提取：

    python tools\mochi_to_boot.py <mochi.ino> tools\boot --cpp firmware\claude_hud\boot_data.h

产物两条出口，同一份数据不会分叉：

  1. `tools\boot\{meta.json,segs.bin,tris.bin}`(3.4 KB)
     → daemon `POST /boot/upload` → BLE BOOT_BEGIN/CHUNK/COMMIT 分片
     → 设备端 LittleFS `/boot/`(原子写，掉电不半截)
  2. `firmware\claude_hud\boot_data.h`(PROGMEM 数组，~3.4 KB flash)
     → 编进 sketch → **首次烧录的设备开一次机就自动落盘 `/boot/`**
     → 即"烧新设备自带开机动画"，不需要每台手动 BLE 传

约束与取舍：

  - 内置只写一次：`/boot/` 文件存在就不动，BLE 上传的动画永远覆盖内置版
  - 动画不进表情槽：162 段塞不进 MAX_PRIMS=16，所以走 LittleFS 流式播放(boot_anim.h)
  - 两份副本(bin 和 .h)靠 `check_firmware.py` 校验字节一致，防改了源忘了重新生成
  - 改 logo 后必须重新生成 + 重烧；只重传 BLE 不动已出厂设备的内置版


---

## 5. 接口契约

### 5.1 BLE 协议 v1

**Service**：沿用现有 `12345678-1234-1234-1234-123456789abc`(**不要改**，见 §9 缓存坑)
**RX Characteristic**(host→device，Write / WriteNR)：`12345678-1234-1234-1234-123456789abd`(沿用)
**TX Characteristic**(device→host，Notify)：`12345678-1234-1234-1234-123456789abe`(新增)
**设备名**：`Claude-HUD`

> 注意：新增 characteristic 会触发 Windows GATT 缓存陈旧问题，首次升级固件后需清除配对记录，见 §9。

**帧格式**(小端)：

+------+-----+------+-----+--------+---------+-----+
| 0xA5 |0x5A | VER  | TYPE| SEQ    | LEN(2)  | ... |
+------+-----+------+-----+--------+---------+-----+
| PAYLOAD (LEN bytes)            | CRC8 |
+--------------------------------+------+

- `VER = 0x01`
- `SEQ`：发送方自增，用于 ACK 匹配
- `CRC8`：poly 0x07，覆盖 VER..PAYLOAD

**消息类型**：

| TYPE | 方向 | 名称 | Payload |
|---|---|---|---|
| 0x01 | H→D | STATE | `u8 state`, `u8 flags` |
| 0x02 | H→D | EXPR_BEGIN | `u8 slot`, `u16 total_len`, `u16 crc16`, `u16 uncomp_len` |
| 0x03 | H→D | EXPR_CHUNK | `u8 slot`, `u16 offset`, `bytes data` |
| 0x04 | H→D | EXPR_COMMIT | `u8 slot` |
| 0x05 | H→D | EXPR_SELECT | `u8 state`, `u8 slot` |
| 0x06 | H→D | CONFIG | `u8 brightness`, `u8 speed`, `u8 rotation`, `u8 idle_timeout_s` |
| 0x07 | H→D | PING | `u32 ts_ms` |
| 0x08 | H→D | TIME_SYNC | `u32 unix_ts`(可选，用于番茄钟) |
| 0x10 | D→H | PONG | `u32 ts_ms`, `u8 fw_major`, `u8 fw_minor`, `u8 slot_count`, `u8 used_slots` |
| 0x11 | D→H | ACK | `u8 acked_type`, `u8 acked_seq`, `u8 code` (0=OK,1=CRC,2=NOSPACE,3=BADREQ) |
| 0x12 | D→H | STATUS | `u8 cur_state`, `u8 ble_connected`, `u8 last_err` |
| 0x13 | D→H | LOG | UTF-8 文本(调试，UI 日志面板显示) |

**状态枚举**：

| 值 | 名称 | 触发 hook |
|---|---|---|
| 0 | IDLE | Stop |
| 1 | THINKING | UserPromptSubmit |
| 2 | TOOL_START | PreToolUse |
| 3 | TOOL_END | PostToolUse(瞬态，1s 后自动回落 1) |
| 4 | WAITING | Notification |
| 5 | ERROR | hook 异常 / daemon 内部错误 |
| 6 | OFFLINE | 主机失联 > 30s(由固件自行判定) |

### 5.2 本地 API(daemon ↔ UI)

`ws://127.0.0.1:17321/ws` 推送事件；REST 供命令：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/status` | daemon 版本、BLE 状态、设备信息、hook 注入状态 |
| GET | `/expressions` | 表情列表 + 元数据 |
| PUT | `/expressions/{id}` | 新增/更新表情 |
| DELETE | `/expressions/{id}` | 删除表情 |
| POST | `/device/connect` \| `/device/disconnect` | 手动控制 |
| POST | `/device/push/{id}` | 下发单个表情 |
| POST | `/device/sync` | 全量同步表情库 |
| POST | `/device/config` | 亮度/速度/旋转 |
| GET | `/hooks/status` | 注入状态、上次修复时间 |
| POST | `/hooks/repair` | 立即重新注入 |
| POST | `/hooks/enable` \| `/hooks/disable` | 开关注入 |
| GET | `/logs/stream` | SSE 日志流 |

WS 推送事件：`ble_state`、`device_state`、`hook_event`、`log`、`expr_progress`、`error`。

### 5.3 Hook 输入输出

Claude Code 传给 hook 的 stdin JSON(我们只用前三个字段)：

{ "session_id": "...", "hook_event_name": "PreToolUse",
  "tool_name": "Bash", "tool_input": {...}, "cwd": "..." }


shim 只向 daemon 发这一行：

{"v":1,"ev":"PreToolUse","tool":"Bash","sid":"ab12","ts":1758600000123}


**shim 硬性要求**：
- 正常路径 < 20ms；异常路径(daemon 未启动)**必须 < 200ms 且 exit 0**，绝不能阻塞 Claude Code。
- 只做一次 `connect()`，超时 150ms；失败即静默退出。
- 永不写 stdout(避免被 Claude Code 当作 hook 控制输出解析)。日志写 stderr 或本地文件。
- 不做 BLE，不做 JSON 复杂解析。

### 5.4 表达式 Schema v1

参数化图元(体积小、BLE 传得快、UI 好编辑)：

{
  "schema": 1,
  "id": "thinking",
  "name": "思考",
  "bg": "#0A0C10",
  "layers": [
    {"type":"rect",   "x":72,"y":50,"w":30,"h":60,"color":"#000000",
     "effect":"none"},
    {"type":"rect",   "x":162,"y":80,"w":30,"h":6,"color":"#000000",
     "effect":"blink","period_ms":900,"on_ms":400},
    {"type":"circle", "cx":200,"cy":30,"r":8,"color":"#5A5856",
     "effect":"pulse","period_ms":1200,"scale":1.4},
    {"type":"poly",   "points":[[x,y],...], "color":"#000000"},
    {"type":"text",   "x":60,"y":190,"size":2,"text":"thinking","color":"#FFFFFF"}
  ],
  "anim": { "fps": 10, "loop": true }
}


图元：`rect` / `circle` / `line` / `poly` / `text` / `sprite`(v2)
效果：`none` / `blink` / `pulse` / `shake` / `spin` / `fade`

**v2 扩展**(P2)：`sprite` 图元承载 RLE 压缩位图(每像素 4bit + RLE)，用于像素画表情和逐帧动画。整屏 240×240×16bit = 115KB，直接传要 30s+，RLE 后典型表情 < 8KB，1~2s 可传完。

**存储**：设备端固定 N 个 slot(建议 12)，每个 slot 存一份压缩后的表达式 blob，写 NVS 或 LittleFS。断电保持。

---

## 6. 技术选型

| 层 | 选型 | 理由 |
|---|---|---|
| 固件 | **PlatformIO + Arduino 框架 + NimBLE-Arduino** | 不用 `BLEDevice`(官方库在 C3 上占 RAM/Flash 大、MTU 与稳定性一般)；NimBLE 更小更快，MTU 协商更可靠。PlatformIO 便于管理分区表和产出合并 bin。 |
| 固件存储 | **NVS(小)+ LittleFS 分区(大)** | 表达式 blob 可能到几十 KB，需要自定义分区表 |
| Daemon | **Python 3.11+ / asyncio / bleak / FastAPI+uvicorn** | `bleak` 是 Windows 上最成熟的 BLE central 实现(走 WinRT)；现有 `daemon/`、`ble_client.py` 已是 Python，可复用；PyInstaller 打包为 sidecar。 |
| Hook shim | **P0 用 Python；P1 换 Go 单文件 exe** | P0 求快；但 Python 冷启动 60~150ms，每次工具调用都叠加，P1 换成编译型(Go 启动 ~3ms、无运行时依赖) |
| UI | **Electron + React + TypeScript + Vite** | 现有 `electron/` 脚手架已跑通并出过 `release/`，直接复用；Electron 支持 Web Serial，可在应用内做首次烧录 |
| 首次烧录 | **esptool-js(Web Serial)** | 用户只需插一次 USB，不需要装 Arduino IDE |
| UI 与 daemon 通信 | **WebSocket + REST(localhost)** | 便于调试(浏览器/curl 直接看)，也天然支持将来做局域网看板 |
| 打包 | **PyInstaller(daemon)+ electron-builder(UI)** | UI 主进程负责 spawn 并守护 daemon |

**为什么不用 Node 做 BLE**：Windows 上 `noble` 系列需要 WinUSB/Zadig 驱动替换，对 BLE GATT(非串口)支持差。BLE 这块 Python 更稳。

**为什么不用 Tauri**：更小更快，但需要 Rust 工具链且 Web Serial 在 WebView2 上支持不完整，而首次烧录是我们的硬需求。

---

## 7. 目录结构(`D:\Claude DIY\代码`)

D:\Claude DIY\代码\
├─ DESIGN.md                      ← 本文档
├─ docs\
|   ├─ PROTOCOL.md                ← BLE 协议表(§5.1 展开)
|   └─ TESTPLAN.md                ← 测试用例(§9 展开)
├─ firmware\                      ← PlatformIO 工程
|   ├─ platformio.ini
|   ├─ partitions_custom.csv      ← app + littlefs + nvs
|   └─ src\
|       ├─ main.cpp               ← setup/loop，非阻塞调度器
|       ├─ config.h               ← 引脚、UUID、常量
|       ├─ ble_service.{h,cpp}    ← NimBLE 服务、MTU、连接回调
|       ├─ protocol.{h,cpp}       ← 帧解析、CRC8/CRC16
|       ├─ state_machine.{h,cpp}  ← 7 状态 + 瞬态回落
|       ├─ renderer.{h,cpp}       ← 非阻塞绘制、图元渲染
|       ├─ expression.{h,cpp}     ← 表达式 JSON 解析、slot 管理
|       ├─ store.{h,cpp}          ← NVS/LittleFS 读写
|       └─ ui_status.{h,cpp}      ← 屏幕常驻状态角标(BLE/主机)
├─ daemon\
|   ├─ pyproject.toml
|   ├─ hud_daemon\
|   |   ├─ __main__.py            ← 入口、生命周期、信号处理
|   |   ├─ config.py              ← 路径、默认值、%APPDATA%\ClaudeHUD
|   |   ├─ ble_link.py            ← 扫描/连接/重连/心跳/MTU
|   |   ├─ protocol.py            ← 帧编解码(与固件对齐)
|   |   ├─ state_map.py           ← hook 事件→状态、去重/节流
|   |   ├─ expressions.py         ← 表情库 CRUD、slot 分配
|   |   ├─ settings_patch.py      ← settings.json 注入 + watchdog
|   |   ├─ ipc_server.py          ← FastAPI + WS
|   |   └─ logbus.py              ← 环形日志 + 订阅
|   └─ tests\
├─ hookshim\
|   ├─ main.go                    ← P1
|   └─ cchud_hook.py              ← P0 临时版
├─ ui\                            ← Electron + React + TS
|   ├─ package.json
|   ├─ electron\{main.ts,preload.ts,sidecar.ts,flash.ts}
|   └─ src\
|       ├─ views\{Status,Expressions,Logs,Settings}
|       ├─ components\ExpressionCanvas.tsx   ← 240x240 预览
|       └─ api\client.ts
└─ tools\
    ├─ merge_bin.py               ← 生成一次性烧录镜像
    ├─ dev_push.py                ← 命令行直接推状态(脱离 Claude Code 调试)
    └─ fake_hook.py               ← 模拟 hook 事件压测


---

## 8. 任务清单

### P0 — 地基(跑通闭环，不做 UI)

> 验收标准：Claude Code 里发一句话 → 屏幕从 IDLE→THINKING→TOOL_START→TOOL_END→IDLE 正确变化；拔掉 ESP 电源再插上，30 秒内自动重连；cc-switch 切换供应商后 1 秒内 hook 自动恢复。

- [ ] **P0-1 固件重写**
  - [ ] 换 NimBLE，拆分 RX/TX 两个 characteristic，MTU 请求 512
  - [ ] 实现帧协议解析 + CRC8 校验 + ACK
  - [ ] **重构为完全非阻塞**：删除所有 `delay()`(当前 `animateToState`、`bootSplash`、`drawToolEndFace` 里都有 100~500ms 阻塞)，改 `millis()` 驱动的动画调度器
  - [ ] 屏幕常驻状态角标：右上角小图标显示 BLE 已连/未连，底部显示主机在线状态
  - [ ] 加 `OFFLINE` 状态：超过 `idle_timeout_s` 没收到任何帧则自动进入，屏幕上明确显示"主机失联"
  - [ ] 5 个状态渲染(沿用现有图形代码，去掉阻塞)
  - [ ] `partitions_custom.csv` + LittleFS 挂载 + slot 读写
  - [ ] 最小表达式解释器(先支持 `rect`/`circle`/`line`/`text`)
- [ ] **P0-2 Daemon 骨架**
  - [ ] `ble_link.py`：扫描(按 service UUID 而非名字，避免同名设备误连)、连接、断开检测、指数退避重连、心跳 PING/PONG
  - [ ] `protocol.py`：编解码 + 单测(与固件用同一组测试向量)
  - [ ] `state_map.py`：事件映射 + 200ms 去重 + TOOL_END 瞬态回落
  - [ ] `ipc_server.py`：`/status`、WS 广播
  - [ ] `logbus.py`：环形缓冲 + 落盘
- [ ] **P0-3 Hook shim**(Python 版)：stdin → localhost 一行 JSON，150ms 超时，静默退出
- [ ] **P0-4 Config Injector**
  - [ ] 哨兵式合并算法(§3.2)
  - [ ] watchdog 监视 + 300ms 防抖 + 自写忽略
  - [ ] 原子写 + 备份 + 解析失败重试
  - [ ] 单元测试：模拟 cc-switch 覆写、用户手改、JSON 半截写入
- [ ] **P0-5 端到端联调**：`tools/fake_hook.py` 先压测，再接真实 Claude Code

### P1 — 可用性(做到"能日常用")

- [ ] **P1-1 Electron UI 壳**：状态面板、托盘常驻、开机自启、daemon 守护与崩溃重启、日志查看
- [ ] **P1-2 表情编辑器 v1**：Canvas 240×240 所见即所得，拖拽图元，效果参数调节，一键下发 + 进度条
- [ ] **P1-3 表情库**：预设模板、导入/导出 JSON、分享
- [ ] **P1-4 设备端持久化验证**：断电重启后表情与亮度配置仍在
- [ ] **P1-5 Hook shim 换 Go 单文件 exe**，实测延迟改善
- [ ] **P1-6 验证 `managed-settings.json` 方案**，可行则升级为首选注入路径

### P2 — 体验提升

- [ ] **P2-1 应用内首次烧录向导**(esptool-js + Web Serial)，含 `merge_bin.py` 产物
- [ ] **P2-2 表达式 v2**：RLE 位图 + 逐帧动画
- [ ] **P2-3 信息增强**：token 用量 / 番茄钟 / 多会话区分(数据源：cc-switch db 或 Claude Code statusline 输出)
- [ ] **P2-4 局域网只读看板**(daemon 多开一个 HTTP 端口，手机可看状态)
- [ ] **P2-5 按键交互**(如果设备有可用 GPIO 接按钮)：切表情、静音、确认

### P3 — 打磨发布

- [ ] 自动更新、崩溃上报、多语言、主题、安装包签名、首次运行引导

---

## 9. 测试计划与已知坑

### 9.1 必须优先验证的三件事(P0 卡点)

1. **cc-switch 覆写行为**：在 cc-switch 里来回切 3 个供应商，每次切换后 2 秒内检查 `~/.claude/settings.json` 的 `hooks` 是否被自动恢复，且 `permissions`/`env` 未被我们改动。这是全项目最大回归风险，建议写成自动化脚本。
2. **hook 不阻塞 Claude Code**：连续触发 20 次工具调用，用 Claude Code 的耗时对比"开 hook / 关 hook"两组，确认单次额外开销 < 50ms。若超，换 Go shim。
3. **`managed-settings.json` 是否被 Claude Code 读取**(Windows 路径 `C:\ProgramData\ClaudeCode\managed-settings.json`)。可行则注入问题一劳永逸。

### 9.2 BLE 相关(Windows 特有)

- **GATT 缓存陈旧**：改了 UUID / 新增 characteristic 后，Windows 会返回旧的服务列表。症状是"连上了但找不到 TX 特征"。处理：设置 → 蓝牙和其他设备 → 删除该设备配对记录，或 `pnputil` 清缓存；必要时临时改设备名(`Claude-HUD-2`)绕过缓存。**所以 P0 阶段尽量不改现有 Service UUID。**
- **单连接限制**：同一时刻只能有一个 central 连上。必须确保 UI 不抢连接(UI 永远只跟 daemon 说话)。
- **同名设备**：按 Service UUID + MAC 过滤，绝不只按名字 "Claude-HUD" 连。
- **MTU 协商**：不同蓝牙适配器结果不同(23~512)。代码必须按实际协商值分片，不能假定 512。
- **重连风暴**：断连后指数退避(1s→2s→4s→8s，上限 30s)，否则适配器会被打满。
- **电脑休眠/蓝牙禁用再启用**：必须能自动恢复。测：休眠 5 分钟唤醒、设备管理器禁用蓝牙适配器 30 秒再启用。
- **ESP32 侧重启**：拔电重插后应在 30 秒内自动重连，且屏幕先显示"等待主机"而非黑屏。

### 9.3 协议与数据

- 分片丢包 / 乱序：每片带 offset，CRC16 在 COMMIT 时校验，失败整包重传。
- 非法/超长 JSON：固件解析必须带长度上限，防止 OOM。
- 中文与 emoji：hook JSON、日志、屏幕文字三处都要确认 UTF-8 全程无乱码(屏幕字库需额外处理，P0 先只支持 ASCII + 少量中文点阵)。
- 协议一致性测试：固件与 daemon 共用一组"测试向量"(输入字节 → 期望帧)，双方单测都跑同一份。

### 9.4 串口

- 运行时**绝不**打开 COM7。Arduino 串口监视器、esptool 烧录、daemon 三者会互相抢占。
- 串口只用于：烧录、看调试日志。daemon 连不上设备时，不要退化成"试串口"。
- COM 口号会变，烧录向导必须让用户手动选端口，不要硬编码 COM7。

### 9.5 测试顺序

① tools/fake_hook.py 直接打 daemon       (无 Claude Code 变量)
② 裸 Python 脚本直连 BLE 推状态          (无 daemon 变量)
③ daemon + fake_hook 全链路              (无 UI 变量)
④ 接真实 Claude Code(手动装 hook)       (无 injector 变量)
⑤ 开 injector 自动注入 + cc-switch 切换压测
⑥ 套上 Electron UI

任何一步失败，只在当前层排查，不要跳到下一层。

---

## 10. 风险登记

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| R1 | cc-switch 覆写 hook，注入器与 cc-switch 互相触发写循环 | 配置损坏 | 哨兵标记 + 内容哈希比对 + 原子写 + 备份；P0-4 专项单测 |
| R2 | Windows BLE 稳定性(缓存、休眠、适配器) | 连接频繁掉 | 指数退避 + 心跳 + UI 明确错误码 + 文档化"清除配对"步骤 |
| R3 | Python daemon 打包后体积大 / 启动慢 | 用户体验 | PyInstaller onedir(非 onefile)；daemon 常驻所以只慢一次 |
| R4 | Hook 延迟拖慢 Claude Code | 核心体验劣化 | 150ms 硬超时 + 静默失败；P1 换 Go |
| R5 | 表达式体积超过 BLE 传输预算 | 换表情很慢 | v1 参数化图元(<2KB)；v2 强制 RLE；进度条 + 可取消 |
| R6 | 固件阻塞式动画导致状态延迟 | 表情跟不上 Claude | P0-1 强制非阻塞重构，禁止 `delay()` |
| R7 | ESP32-C3 内存不足(BLE + 屏幕缓冲 + JSON 解析) | 崩溃重启 | NimBLE 替代 BLEDevice；表达式流式解析，不全量缓冲；实测 heap 水位 |
| R8 | 屏幕字库 / emoji 支持 | 部分表情做不出 | P0 只用几何图元；文字先限 ASCII |

---

## 11. 已确认的硬件与运行前提(2026-09-23 实测)

用 `python -m esptool --port COM7 flash-id` 实测，不必你手动翻：

| 项 | 实测值 | 对设计的影响 |
|---|---|---|
| 芯片 | ESP32-C3 (QFN32) rev v0.4，单核 160MHz | 与接线表一致 |
| **Flash** | **4MB**(Manufacturer 0x46 / Device 0x4016) | 用 IDE 内置分区方案即可，无需自定义分区表 |
| 无线 | BT 5 (LE) | 够用；BLE 5 的 2M PHY 可进一步降延迟 |
| USB 模式 | USB-Serial/JTAG(芯片内置) | 不需要外部 USB-TTL，COM7 就是它 |
| MAC | 90:da:72:89:65:1c | 仅用于日志识别；**不要**拿它做 BLE 过滤(用 Service UUID) |
| 串口 | COM7 存在，描述"USB 串行设备" | 只用于烧录与调试日志 |
| 按键 | BOOT 键(GPIO 9)可用 | P2-5 交互启用。GPIO9 是 strapping 引脚，开机瞬间按住会进下载模式——这是预期行为 |
| 烧录 | **Arduino IDE**；ESP32 core **3.3.11** 已装 | 固件以 Arduino sketch 交付，不用 PlatformIO |
| 托盘常驻 + 开机自启 | 默认开启 | UI 默认值 |

**Flash 预算分配(4MB)**

| 区域 | 大小 | 用途 |
|---|---|---|
| bootloader + 分区表 | ~32KB | 固定 |
| app0 | ≤1.2MB | 固件(NimBLE + GFX + ST7789 + 表达式解释器)，预估 ~700KB |
| spiffs(挂载为 LittleFS) | ~1.5MB | 表情 blob 与用户配置 |
| nvs | 20KB | 亮度 / 速度 / 状态→slot 映射 |
| coredump | 64KB | 崩溃现场 |

1.5MB 表情空间的含义：参数化图元表情按 2KB 算约 750 个；v2 的 RLE 位图表情按 8KB 算约 180 个。完全够用。

---

## 12. 立即可以开始的第一个动作

按依赖顺序，第一件事是 **P0-1 固件的非阻塞重构 + 屏幕状态角标**，因为它同时解决你提的第一个痛点(重启后看不到 BLE 状态)，并且是后续所有链路的前提。

第二个动作是 **P0-4 Config Injector 的单元测试**，因为它风险最高，且完全不依赖硬件，可以并行推进。

---

## 附录 A：v0.2 修订(2026-09-23)

本节修正 §6 与 §8 中已过时的选型。其余章节不变，冲突时以本节为准。

| 项 | 原方案 | 修订为 | 原因 |
|---|---|---|---|
| 固件工程形态 | PlatformIO + 自定义 `partitions_custom.csv` | **Arduino sketch(.ino) + Arduino IDE 2.x + core 3.3.11 + IDE 内置分区方案** | 你选定 Arduino IDE。自定义分区表在 IDE 下要改 `boards.txt`，收益低风险高，直接不做 |
| 首次/日常烧录 | 应用内 esptool-js + Web Serial | **Arduino IDE 图形烧录 + `tools/flash.ps1`(esptool v5.4.0 命令行刷 release bin)** | esptool-js 已确认无用武之地；IDE 与 esptool 本机都已就绪。应用内烧录降级为 P3 可选 |
| 表达式存储 | NVS + LittleFS 双写 | **LittleFS 为唯一表情载体，NVS 只放 20 字节级小配置** | 避免双份存储带来的一致性 bug；1.5MB LittleFS 足够 |

**固件依赖**(Arduino IDE → 库管理器安装)：

- `NimBLE-Arduino`(2.x)——替代内置 `BLEDevice`，省 RAM 且 MTU 协商更稳
- `Adafruit GFX Library`
- `Adafruit ST7789 Library`(你现有代码已在用)
- `ArduinoJson`(7.x)——流式解析表达式 JSON，避免全量缓冲撑爆内存

**IDE 板卡设置**(烧录前必须对齐)：

- Board: `ESP32C3 Dev Module`
- USB CDC On Boot: `Enabled`(否则串口日志看不到)
- Flash Size: `4MB (32Mb)`
- Partition Scheme: `Default 4MB with spiffs (1.2MB APP/1.5MB SPIFFS)`
- Upload Speed: `921600`

**P0-1 拆解相应调整**：

- 交付物为 `firmware/claude_hud/claude_hud.ino`，Arduino IDE 打开即用
- 新增 **P0-1a 编译验证**：用 IDE 自带 arduino-cli 做无硬件编译，先确认 NimBLE 2.x API 与 core 3.3.11 兼容，再上板
- 新增 **P0-1b 烧录流程文档化**：把上面的板卡设置写成 `firmware/FLASHING.md`

**P2-5 按键交互方案(GPIO 9 / BOOT 键)**：

- 短按(<500ms)：预览下一个表情
- 双击：切换背光
- 长按(>3s)：恢复出厂表情库
- 开机时按住：进下载模式(strapping 行为，保留不改)

---

## 附录 B：Hook shim 基准数据(2026-09 实测)

8 次取中位数,整进程成本:

| 实现 | 中位数 | 最小值 | 最大值 |
|---|---|---|---|
| `cchud-hook.exe`(NativeAOT 编译) | 48.8 ms | 45.8 ms | 1042.4 ms |
| `cchud_hook.py`(Python) | 695.4 ms | 275.8 ms | 1127.7 ms |

编译型比 Python 快 14.2 倍。一次 turn 里 20 次工具调用可省 12.9 s,或在 shim 更慢时避免阻塞。

此数据支撑 §6 选型表 P1-5(换 Go/编译型单文件 exe)的投入合理性。
