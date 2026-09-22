# CUA — Computer Use for DeepSeek Harness

[English](README.en.md) | 中文

让模型看见并操作本机桌面：读取前后台应用的 UI 控件树、截图、模拟鼠标键盘，以及直接向 GUI 应用发送 Apple Event。

当前实现覆盖 **macOS**（Accessibility + ScreenCaptureKit + Quartz Event Services + Apple Events）。引擎的 JSON-RPC 协议与插件的工具层是平台无关的，新增 Windows（UIAutomation）或 Linux（AT-SPI）后端不需要改动这两层。

## 目录结构

```
cua/
└── packages/dsh-plugin-cua/
    ├── src/                          # TypeScript 插件（DSH 侧）
    │   ├── index.ts                  # 插件入口：注册工具 + system prompt 指导
    │   ├── engine-client.ts          # 引擎子进程客户端（NDJSON over stdio）
    │   ├── approval.ts               # 写操作授权门（读自由 / 写确认）
    │   ├── config.ts                 # 配置 schema（schemastery）
    │   ├── shared.ts                 # 结果归一化与渲染辅助
    │   ├── tools-observe.ts          # cua_status / cua_displays / cua_apps / cua_windows / cua_tree / cua_screenshot
    │   ├── tools-interact.ts         # cua_click / cua_type / cua_key / cua_element
    │   └── tools-app.ts              # cua_app
    ├── native/cua-engine/            # Swift 原生引擎
    │   └── Sources/CuaEngine/
    │       ├── Engine.swift          # 协议分发循环 + stdio 服务
    │       ├── Protocol.swift        # 请求/响应/错误码 + PlatformHost 平台接口
    │       ├── MacHost.swift         # macOS 后端：权限、应用、窗口、控件树
    │       ├── MacHost+Actions.swift # macOS 后端：指针、键盘、元素动作、截图、应用控制
    │       ├── Tree.swift            # 控件树遍历（预算、过滤、大纲渲染）
    │       ├── Capture.swift         # ScreenCaptureKit 截图与坐标系转换
    │       ├── Pointer.swift         # CGEvent 鼠标事件
    │       ├── Keyboard.swift        # CGEvent 键盘 / Unicode 文本 / 虚拟键码表
    │       ├── AppleEvents.swift     # AppleScript 与 NSWorkspace 应用控制
    │       ├── AX.swift, AXArray.swift, JSONValue.swift, JSONReader.swift
    │       └── main.swift            # CLI 入口（serve / --probe / --call）
    ├── scripts/
    │   ├── build-engine.mjs          # 编译 Swift 引擎并落到 lib/bin/
    │   ├── smoke.mjs                 # 端到端冒烟测试（真实引擎、真实系统）
    │   └── check-schemas.mjs         # 用 harness 自己的校验器验证工具 schema
    └── lib/                          # 构建产物：index.js + bin/cua-engine
```

## 两层设计

**Swift 引擎（`cua-engine`）** 是唯一的进程，持有所有 OS 能力。它是一个长期存活的子进程，stdin/stdout 上跑一行一个 JSON 对象的 RPC：

```json
{"id":1,"method":"tree.dump","params":{"app":"Finder","maxDepth":4}}
{"id":1,"result":{"app":"Finder","pid":642,"nodes":[...],"text":"[0] AXApplication …"}}
{"id":2,"error":{"code":"permission_denied","message":"…","settingsPane":"…"}}
```

它之所以单独成进程，有三个实际理由：

1. **TCC 授权对象明确**。macOS 把辅助功能/屏幕录制授权给进程（及其 responsible process），一个独立的小二进制比整个 Electron 应用更容易审计和授权。
2. **崩溃隔离**。目标应用无响应时，AX 调用会卡住；卡住的是引擎，不是 harness。
3. **状态复用的位置正确**。控件树快照（按索引寻址）、窗口 id、超时预算都活在引擎里，不必每次调用重建。

**TypeScript 插件** 只做三件事：注册工具、把引擎结果转成模型可读的文本、在写操作前过授权门。

## 工具

| 工具 | 作用 | 权限 |
|---|---|---|
| `cua_status` | 引擎/权限状态与修复指引，`request:true` 触发系统授权弹窗 | 无 |
| `cua_displays` | 显示器布局：每块屏的 id、矩形、像素密度，以及桌面总范围 | 无 |
| `cua_apps` | 列出运行中/已安装的应用（名称、bundle id、pid、是否前台） | 无 |
| `cua_windows` | 列出屏幕上的窗口：`windowId`、所属应用、标题、屏幕矩形 | 辅助功能 |
| `cua_tree` | 控件树，一行一个元素并带索引；可按角色/交互元素/几何过滤 | 辅助功能 |
| `cua_screenshot` | 窗口/显示器/区域截图，落盘为 PNG/JPEG，返回路径+区域+缩放 | 屏幕录制 |
| `cua_click` | 点击/双击/右键/拖动/滚动；`route:post` 走窗口服务器，`route:pid` 直达进程 | 辅助功能 |
| `cua_type` | 输入文本（Unicode 走事件 payload，任意键盘布局/CJK/emoji 均可） | 辅助功能 |
| `cua_key` | 命名按键与组合键（`cmd+shift+t`、`return`、`left`、`f5`） | 辅助功能 |
| `cua_element` | 让元素自己执行动作：`press`/`setValue`/`focus`/`scrollToVisible`/`menu`/`list` | 辅助功能 |
| `cua_app` | 应用生命周期与 GUI 消息：`activate`/`quit`/`launch`/`openURL`/`reveal`/`menu`/`script` | 辅助功能；`script` 另需自动化授权 |

### 坐标系

全链路统一为 **左上角原点的屏幕点（screen points）**，与 `cua_windows` 的 `frame`、`cua_tree` 的几何、`cua_screenshot` 的 `region` 一致。Quartz 事件用左下角原点，转换在引擎内部完成且只做一次。

截图额外返回 `scale`（图像像素 / 屏幕点），因此：图像像素 `(px, py)` → 屏幕点 `(region.x + px/scale, region.y + py/scale)`。

### 多显示器

这是最容易出错的一块，所以单独说明。

**坐标系**：全局统一为左上角原点的屏幕点。主屏左上角是 `(0,0)`，主屏**上方**的副屏 y 为负，**左侧**的副屏 x 为负。`cua_displays` 会直接列出每块屏的矩形和桌面总范围。

这里有个真实的 API 陷阱：`NSScreen.frame` 是**左下原点**，而 `SCDisplay.frame`（ScreenCaptureKit）和 `CGWindowListCopyWindowInfo` 是**左上原点**。混用这两者时，只要副屏位于主屏上方或左侧就会静默指错屏幕。引擎里所有几何判断只用后者的空间，AppKit 的几何不参与任何决策。

**像素密度不是常数**。同一块屏在不同调用下会给出不同的像素/点比值：

- `SCDisplay.width / frame.width` 在你机器上主屏报 1.0，但实际以 2x 渲染——这个比值不可信。
- `captureImage(in:)` 会按区域大小**静默切换密度**：同一块屏上 400×300 的区域返回 2x，800×600 的区域返回 1x。

所以引擎在首次用到某块屏时做一次**标定**（整屏原生抓一张、量出真实密度并缓存），之后所有区域截图、窗口截图、整屏截图都按该密度显式设定输出尺寸。结果是每块屏的密度各自恒定且可复现：

```
主屏 (1512x982 点)  -> 400x300 点区域 = 508x381 像素  scale=1.270
副屏 (1920x1080 点) -> 400x300 点区域 = 400x300 像素  scale=1.000
```

而且每次截图的 `scale` 都是**从回来的图里量出来的**，不是假设值——窗口截图会带上窗口自身的 backing scale，与同屏区域截图不同。模型必须用当次结果里的 `scale`，不能用记住的值。截图的 `region` + `scale` 永远精确描述它收到的那张图。

**越界即拒绝**：落点不在任何显示器上会被直接报错并附上桌面实际范围，而不是让窗口服务器把光标夹到屏幕边缘再投递事件——后者会把一次坐标算错变成一次"点到了别处"。

**显示器归属**：`cua_screenshot` 会返回 `displayId`，`window.list` 的窗口与显示器按最大重叠匹配。跨屏窗口按重叠面积归给占比最大的那块屏。

**截图区域会被裁到单块屏**。区域只部分落在某块屏上时会被裁到重叠部分并置 `clipped: true`，`region` 报的是**实际截到的范围**而不是请求的范围——否则 `region × scale` 会对应到图里不存在的像素。带空洞的多屏布局下这是常态：整桌面并集横跨屏幕之间的空隙，所以无参数截图取的是**主显示器**而不是并集。

**窗口截图不设 `sourceRect`**。把 `sourceRect` 设成窗口自身的 frame（"就裁成它自己"）会让 ScreenCaptureKit 报 `-3811`；窗口 filter 本来就精确产出该窗口，强制输出尺寸还会把 2x 窗口压成 1x。

### 可靠性阶梯

插件在 system prompt 里显式要求模型按下列顺序选择手段，能用高层就不用底层：

1. `cua_app` + `script` — 目标应用自己完成工作
2. `cua_app` + `menu` / `activate` / `openURL` — 直接 API 调用，不碰指针
3. `cua_element` — 元素自执行动作，可在后台窗口工作，不存在"点偏"
4. `cua_type` + `element` — 聚焦该控件并把按键投给它的进程，后台窗口同样有效
5. `cua_click` / 不带 element 的 `cua_type` / `cua_key` — 合成输入，面向最前台，仅在无辅助功能界面时使用

### 操作后台应用

这是**一等公民场景**，而且它会改变"哪个机制才是对的"：

**读取完全不依赖焦点。** `cua_tree` / `cua_screenshot` / `cua_windows` 以及按窗口截图都直接寻址后台应用。窗口在别的屏、或被别的窗口盖住，照样能截到——`cua_click` 的坐标不需要先把它弄到可见位置。

**`cua_element` 是后台安全的操作方式。** 动作由目标应用通过辅助功能 API 执行，不需要任何窗口在最前台，也不会把焦点从用户手上抢走。

**`cua_type` 必须带 `element` 才能写到后台窗口。** 这是实测结论，不是推测：

| 调用 | 后台窗口结果 |
|---|---|
| `cua_element` + `setValue` | ✅ 写入成功，前台应用未变 |
| `cua_type` + `element` | ✅ 写入成功（引擎先 AX 聚焦该元素，再按 pid 投递） |
| `cua_type` 不带 element | ❌ 报告 delivered=true，但**文本被后台应用丢弃** |
| `cua_type` + `route:pid` 但不先聚焦 | ❌ 同样报告 delivered=true，实际丢弃 |

原因是 `CGEventPostToPid` 确实把按键事件投给了目标进程，但该应用会忽略它们——除非它自己的 AX 焦点已在目标控件上。所以不带 element 时不投递到后台应用，而是打到最前台。

**不要为了读取而激活应用。** 把它弄到前面会改变用户正在看的东西，而所有读取都不需要这么做。

**`cua_click` 的 `route: "pid"`** 可以只对某个进程投递、不动可见光标，但合成点击远不如元素动作可靠，且依赖窗口确实在预期的位置。

## 构建

```sh
cd packages/dsh-plugin-cua
pnpm install
pnpm run build          # 编译 Swift 引擎 + 打包插件
```

产物：

- `lib/bin/cua-engine` — Swift release 二进制
- `lib/index.js` — 单文件 ESM 插件包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 保持 external，运行时由 harness 解析，保证服务实例同一性）
- `lib/types/*.d.ts` — 类型声明

校验：

```sh
pnpm run typecheck       # tsc --noEmit
pnpm run check:schemas   # 用 harness 的校验器验证每个工具的入参/出参 schema
pnpm run smoke           # 端到端：加载插件 + 调用真实引擎
pnpm run smoke:writes    # 额外移动一次指针、按一次 shift（会有可见副作用）
```

## 安装（作为插件包安装）

这个包**声明了 `dsh.bundle`**，本身就是一个可被 DSH 插件管理器安装的组合包。在 DSH 的 **设置 → Plugins → Add plugin** 里填这个包的**绝对路径**：

```
/Users/hh.liu/code/cua/packages/dsh-plugin-cua
```

插件管理器会把它加成 profile 的一个 bundle 层，包内的 `cordis.patch.yml` 提供一行 `mcp-cua`：经 `@deepseek-ai/dsh-mcp-client` 接入引擎的 MCP server，工具在模型侧显示为 **`mcp__cua__<name>`**。

安装后**重启应用**，并且在**新建的会话**里使用——见下方"已知行为"。

> 包若被移动到别处，改 `cordis.patch.yml` 里那一处绝对路径。用绝对路径是刻意的：打包版 harness 把裸包名解析到**自身安装目录**，看不到 profile 的 `node_modules`；绝对路径是唯一能触达安装目录之外的形式。

### 已知行为：工具在既有会话中不可见

> 完整排查记录见 [docs/case-study-tool-visibility.md](docs/case-study-tool-visibility.md)——包含四个我曾误判的结论和可复用的诊断手法。

工具由宿主启动时注册。**在那个宿主启动之前就已存在、之后被恢复的会话看不到它们**；新建的会话可以。实测：同一个宿主里，一个跨越多次重启恢复的老会话调不到工具，新建会话正常。

这不是本插件特有的问题——挂在 profile / bundle 层的工具都有这个特性。遇到"工具不在"时，先新建一个会话再判断。

### 为什么不用原生插件行

包内也曾提供一行原生插件（直接注册 `cua_*`）。它能工作，但与 MCP 那行**同时存在**会让模型看到两套同义工具（`cua_*` 与 `mcp__cua__*`，共 24 个），所以收敛成 MCP 一套。原生那套的注册路径已验证可用，需要短名字时可以把 `cordis.patch.yml` 换成原生行：

```yaml
- insert:
    - id: cua
      name: <包目录>/lib/index.js
      config:
        enginePath: <包目录>/lib/bin/cua-engine
        writeApproval: never
        idleShutdownMs: 600000
```

## 手动接入（不用插件管理器时）

### 方式 A：MCP provider

引擎内置 MCP server 模式（`cua-engine --mcp`），通过 `dsh-mcp-client` 接入。工具在模型侧显示为 `mcp__cua__<name>`。

这是**推荐方式**，也是仓库既有的 computer-use provider 走的路子（`packages/computer-use`、`packages/experimental/computer-use-cua-driver-mcp`）。在 `cordis.patch.yml` 里：

```yaml
- insert:
    - id: mcp-cua
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: cua
        transport: stdio
        command: /path/to/cua/packages/dsh-plugin-cua/lib/bin/cua-engine
        args: [--mcp]
        toolCallTimeoutMs: 120000
        failOnStartupError: false
        reconnect: { enabled: true }
```

MCP 模式下截图由引擎写盘并返回路径（MCP 客户端只把结果投影成文本，base64 会变成给模型的无用文本）。截图目录默认 `~/.dsh/cua-screenshots`，可用 `DSH_CUA_SCREENSHOT_DIR` 覆盖。

### 方式 B：原生插件包

> 注意：这条路径目前**在桌面应用里不可用**。插件能加载、能注册工具，但模型看不到它们；原因尚未查明（详见下方"已知限制"）。



> **先确认要装进哪个 profile。** `~/.dsh/profiles/` 下每个目录是一个 profile，桌面应用只启动其中一个。装错的那个会被完整加载、11 个工具全部注册，但永远不会被用到——而失败表现是"工具不存在"，和一个加载失败的插件完全一样。用 `lsof -p <宿主 pid> | grep profiles` 读出真实答案，别猜。

1. 把包放进 profile 的依赖里（`~/.dsh/profiles/<profile>/package.json`）：

   ```json
   { "dependencies": { "@deepseek-ai/dsh-plugin-cua": "link:/path/to/cua/packages/dsh-plugin-cua" } }
   ```

   然后在 profile 目录执行 `dsh plugin install`（或 `pnpm install`）。若该 profile 由桌面应用管理、`dsh` 拒绝操作，直接建符号链接即可（`node_modules/@deepseek-ai/dsh-plugin-cua` → 包目录），与 profile 既有的链接方式一致。

2. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加：

   ```yaml
   - insert:
       - id: cua
         name: '@deepseek-ai/dsh-plugin-cua'
         config:
           enginePath: /path/to/cua/packages/dsh-plugin-cua/lib/bin/cua-engine
           writeApproval: never        # always | session | never
           screenshotDir: ~/.dsh/cua-screenshots
           idleShutdownMs: 600000
   ```

3. 重启 harness（引擎二进制路径与 TCC 授权都在启动时确定）。

## 权限（macOS）

引擎报告的状态来自 `AXIsProcessTrusted()` 与 `CGPreflightScreenCaptureAccess()`，`cua_status` 会直接告诉你缺什么、去哪里开。

| 权限 | 覆盖 | 授权对象 |
|---|---|---|
| 辅助功能 Accessibility | 控件树、点击、输入、元素动作、窗口操作 | 承载引擎的宿主进程（`DeepSeek Harness`，或从终端启动时的终端应用） |
| 屏幕录制 Screen Recording | 截图 | 同上 |
| 自动化 Automation | `cua_app` 的 `script`（Apple Event） | 按被控应用逐条授权，首次调用时弹窗 |

要点：

- 授权按 **responsible process** 归属，**不是按二进制**。实测：把同一个引擎复制成一个从未被授权过的全新文件名，它立刻报告的仍是 `true`——因为授权跟着"谁拉起了它"，而不是跟着可执行文件本身。推论有两条，都很实用：
  - **重建/移动引擎不会丢权限**（每次 `swift build` 的 cdhash 都不同，若按二进制归属就永远无法满足）。
  - **要在系统设置里勾选的是宿主应用**（你的情况是 `DeepSeek Harness`），不是 `cua-engine`，也不是你启动它的终端。
- `cua_status` 的提示会直接说出宿主应用名和 pid，照着它给的路径勾选即可。系统设置的列表里如果找不到该应用，用 `+` 从 `/Applications` 添加。
- 修改授权后必须**退出并重启**宿主应用才生效——macOS 只在进程启动时读取授权状态。
- 未授权时工具不会静默返回空结果：`window.list` / `tree.dump` 会显式报 `permission_denied`（否则 AX 会返回空属性集，看起来像"这台机器上没有窗口"）。
- `cua_app` 的 `script` 会在独立队列上跑，并受硬超时保护。首次调用可能弹出自动化授权对话框；如果无人应答，引擎不会把后续请求堆在这个线程后面，而是直接返回"上一个脚本仍在运行"。

## 写操作授权

插件划一条线：**读自由，写过门**。

- **读**（`cua_status` / `cua_apps` / `cua_windows` / `cua_tree` / `cua_screenshot`，以及 `cua_element action:list`）不额外询问——它们只观察机器，且 macOS 已经用 TCC 把门了。
- **写**（`cua_click` / `cua_type` / `cua_key` / `cua_element` 的变更动作 / `cua_app`）先经过 `ctx.approval`，失败即拒绝（fail closed）。

`writeApproval` 三档：

| 取值 | 行为 | 适用 |
|---|---|---|
| `always` | 每次写操作都询问 | 会话能弹窗时的默认选择 |
| `session` | 每个写工具在会话内问一次，之后复用授权 | 减少打断 |
| `never` | 不询问，macOS 授权即唯一门 | 会话审批策略为 `never`（无人应答）时**唯一可用**的档位，否则审批被自动拒绝会导致写操作全部失败 |

**当前 profile 配置为 `never`**：这个会话的审批提示是关闭的，被拒绝的审批会直接阻断写操作。若要改成逐次确认，把 `cordis.patch.yml` 里的 `writeApproval` 改为 `always` 或 `session` 并重启。

## 引擎 CLI

引擎可以脱离插件单独使用，便于排查：

```sh
lib/bin/cua-engine --probe                                  # 打一条状态就退出
lib/bin/cua-engine --call tree.dump --params '{"app":"Finder"}'   # 单次调用
lib/bin/cua-engine --version
lib/bin/cua-engine --help

# 有状态用法：同一次进程内，先取树，再按索引点它
printf '%s\n' \
  '{"id":1,"method":"tree.dump","params":{"app":"Finder","maxDepth":4}}' \
  '{"id":2,"method":"element.action","params":{"element":5,"action":"list"}}' \
  | lib/bin/cua-engine
```

## 协议参考

方法：`engine.status`、`engine.permissions`、`engine.request_permissions`、`app.list`、`window.list`、`tree.dump`、`capture.screenshot`、`pointer`、`keyboard`、`element.action`、`app`。

错误码：`invalid_request`、`unknown_method`、`not_found`、`permission_denied`、`operation_failed`、`unsupported_platform`。插件用 `EngineError.code` 区分它们，`permission_denied` 会附带 `settingsPane`。

设计约定：

- `params` 类型错误一律报错，不做静默降级。坐标写成字符串会被拒绝，而不是退化成"点击元素中心"——后者会点错东西。
- 落点必须在某块显示器上，否则报错并给出桌面实际范围。
- 同一个概念只有一个字段。截图区域曾经在请求结构里存在两个等价字段（`region` 与 `sourceRect`），调用方只填其中一个，于是 `region` 恒为 `[0,0,0,0]`；现在只保留 `region`。
- 需要索引寻址的调用在快照缺失或索引越界时显式失败，并提示重跑 `cua_tree`，绝不把旧索引套用到新元素上。
- 结果里文档化的字段始终存在（无值为 `null`），调用方不必用 `in` 判断。

## 测试

```sh
make check          # 类型 + schema + 冒烟（不产生可见副作用）
make smoke-writes   # 额外包含真实指针移动、按键，以及后台应用读写
```

`smoke-writes` 会真的启动 TextEdit、把前台让给别的应用、在**后台**写入并读回，同时断言前台应用没有被抢走——后台操作这条保证就是这么守住的。

## 下一步

交接文档：[docs/HANDOFF.md](docs/HANDOFF.md)——待办清单、未验证的代码路径、以及每项的判断依据。
排查记录：[docs/case-study-tool-visibility.md](docs/case-study-tool-visibility.md)。

## 已知限制

- **仅 macOS**。其他平台会加载插件但所有引擎调用返回 `unsupported_platform`。
- **跨屏区域按最大重叠归属单块屏**。一块跨两块屏的区域不会被拼接成一张图；它由重叠面积最大的那块屏捕获，超出该屏的部分为空白/黑边。需要完整跨屏视图时分别截两块屏。
- **锁屏时不可用**。屏幕锁定时 ScreenCaptureKit 会以 `-3811` 失败，且最前台应用会变成 `loginwindow`，控件树与输入都不可靠。插件会显式报告 `the screen is locked`，`cua_status` 也会把 `sessionLocked` 标为 true 并让 `ready` 为 false，而不是把 ScreenCaptureKit 的原始错误抛给模型。
- **控件树必然被预算截断**。浏览器、Electron 应用的树可达数万节点，因此默认节点上限 1200、深度 8、时间预算 8s。结果里的 `truncatedBy` 会说明是哪个预算触发的，据此收窄查询而不是假设"看全了"。
- **`cua_type` 走合成事件**，某些应用会丢弃过快的输入；必要时用 `perCharacterDelayMs` 降速。不带 `element` 时对后台应用无效（见上文表格）。
- **`route: "pid"` 的合成点击**对后台窗口能否生效取决于具体应用，不做保证；需要可靠的后台操作请用 `cua_element`。
- **窗口标题需要屏幕录制权限**，这是 macOS 的限制，不是实现选择。
- **`element.action` 的索引只在同一引擎会话内有效**。引擎空闲 10 分钟后退出，之后索引失效需要重新取树。**MCP 模式下引擎由 MCP 客户端托管**，生命周期随之而定。
- **原生插件行在桌面应用里工具不可见（未查明）**。已确认的事实：插件在会话所在进程内加载、`apply()` 完整跑完、12 个工具确实在 `ctx.tools.schemas()` 里（插件自己回读的日志为证）、没有任何 `tools.restrict()` 约束它、声明路径与出参 schema 都验证过、工具也不会随时间消失。但 `wireSchemas(scope)` 生成的模型目录里没有它们。可疑方向是 `ScopedLayers.effect` 的 `scopeOf(ctx)` 判定——带 scope 标签的 ctx 会注册进该 scope 的私有层，只有该 scope 及其子代可见。诊断代码在插件里（`DSH_CUA_BOOT_LOG`），但读取 `scopeOf` 需要解析 asar 内的 `@deepseek-ai/dsh-scope`，尚未跑通。MCP 方式绕过了这个问题。
- **连续截图有瞬时失败**。ScreenCaptureKit 在快速连续捕获时会间歇性报 `-3811`，引擎对这类错误做有限重试（3 次、递增退避）后才上报。
