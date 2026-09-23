# CUA — Computer Use for DeepSeek Harness

[English](README.en.md) | 中文

让模型看见并操作本机桌面：读取前后台应用的 UI 控件树、截图、模拟鼠标键盘，以及直接驱动应用本身。

当前实现覆盖 **macOS**（Accessibility + ScreenCaptureKit + Quartz Event Services + Apple Events）与 **Windows**（UI Automation + SendInput + GDI 屏幕捕获 + Shell）。引擎的 JSON-RPC 协议与插件的工具层是平台无关的：两个后端实现同一套方法、同一组响应字段、同一组错误码，所以工具面完全不变。Windows 后端与 macOS 的差异（以及每一处差异的理由）见 [docs/windows-backend.md](packages/dsh-plugin-cua/docs/windows-backend.md)；引擎的完整线上契约见 [docs/engine-contract.md](packages/dsh-plugin-cua/docs/engine-contract.md)。

## 目录结构

```
cua/
└── packages/dsh-plugin-cua/
    ├── src/                          # TypeScript 插件（DSH 侧，平台无关）
    │   ├── index.ts                  # 插件入口：注册工具 + system prompt 指导
    │   ├── engine-client.ts          # 引擎子进程客户端（NDJSON over stdio）
    │   ├── approval.ts               # 写操作授权门（读自由 / 写确认）
    │   ├── config.ts                 # 配置 schema（schemastery）
    │   ├── platform.ts               # 按宿主平台选择工具描述与提示词措辞
    │   ├── shared.ts                 # 结果归一化与渲染辅助
    │   ├── tools-observe.ts          # cua_status / cua_displays / cua_apps / cua_windows / cua_tree / cua_screenshot
    │   ├── tools-interact.ts         # cua_click / cua_type / cua_key / cua_element
    │   └── tools-app.ts              # cua_app
    ├── native/cua-engine/            # macOS 原生引擎（Swift）
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
    │   ├── native/cua-engine-win/        # Windows 原生引擎（C# / .NET 9）
    │   │   ├── CuaEngine.csproj
    │   │   ├── app.manifest              # 逐显示器 DPI 感知 v2
    │   │   └── src/
    │   │       ├── Program.cs            # STA 入口 + stdio 循环 + CLI
    │   │       ├── Protocol.cs           # 与 Swift 侧同一套信封与错误码
    │   │       ├── Params.cs             # 严格类型化的参数读取
    │   │       ├── PlatformHost.cs       # PlatformHost 接口 + 分发
    │   │       └── Win/
    │   │           ├── Native.cs         # Win32 / DWM / GDI / Shell 互操作
    │   │           ├── Discovery.cs      # 显示器、窗口、进程
    │   │           ├── Keymap.cs         # 键名 → 虚拟键码
    │   │           ├── WinHost.cs        # 权限、显示器、应用、窗口
    │   │           ├── WinHost.Tree.cs   # UIA 遍历、大纲、元素快照
    │   │           ├── WinHost.Capture.cs / Input.cs / Element.cs / App.cs
    ├── scripts/
    │   ├── build-engine.mjs          # 按 process.platform 选工具链编译引擎
    │   ├── smoke.mjs                 # 端到端冒烟测试（真实引擎、真实系统）
    │   └── check-schemas.mjs         # 用 harness 自己的校验器验证工具 schema
    ├── docs/                         # 引擎线上契约 + Windows 后端说明
    └── lib/                          # 构建产物：index.js + bin/cua-engine（macOS 为单文件，Windows 为目录）
```

## 两层设计

**原生引擎（`cua-engine`）** 是唯一的进程，持有所有 OS 能力。它是一个长期存活的子进程，stdin/stdout 上跑一行一个 JSON 对象的 RPC：

```json
{"id":1,"method":"tree.dump","params":{"app":"Finder","maxDepth":4}}
{"id":1,"result":{"app":"Finder","pid":642,"nodes":[...],"text":"[0] AXApplication …"}}
{"id":2,"error":{"code":"permission_denied","message":"…","settingsPane":"…"}}
```

它之所以单独成进程，有三个实际理由：

1. **授权对象明确**。macOS 把辅助功能/屏幕录制授权给进程（及其 responsible process），一个独立的小二进制比整个 Electron 应用更容易审计和授权。
2. **崩溃隔离**。目标应用无响应时，AX 调用会卡住；卡住的是引擎，不是 harness。
3. **状态复用的位置正确**。控件树快照（按索引寻址）、窗口 id、超时预算都活在引擎里，不必每次调用重建。

**TypeScript 插件** 只做三件事：注册工具、把引擎结果转成模型可读的文本、在写操作前过授权门。工具描述与提示词里所有平台特有的措辞都来自 `src/platform.ts`，所以 Windows 会话不会读到"用 cmd+s 打开"或"在系统设置里打开辅助功能"这类在它那台机器上不成立的话。

## 工具

| 工具 | 作用 | 权限 |
|---|---|---|
| `cua_status` | 引擎/权限状态与修复指引（纯读） | 无 |
| `cua_request_permissions` | 请求缺失的授权，并返回与 `cua_status` 相同的报告；macOS 会弹系统对话框，Windows 没有可授予项，只回报状态 | 无 |
| `cua_displays` | 显示器布局：每块屏的 id、矩形、像素密度，以及桌面总范围 | 无 |
| `cua_apps` | 列出运行中/已安装的应用（名称、应用 id、pid、是否前台） | 无 |
| `cua_windows` | 列出屏幕上的窗口：`windowId`、所属应用、标题、屏幕矩形 | 辅助功能（macOS） |
| `cua_tree` | 控件树，一行一个元素并带索引；可按角色/交互元素/几何过滤 | 辅助功能（macOS） |
| `cua_screenshot` | 窗口/显示器/区域截图，落盘为 PNG/JPEG，返回路径+区域+缩放 | 屏幕录制（macOS） |
| `cua_click` | 点击/双击/右键/拖动/滚动；`route:post` 走窗口服务器（macOS）/ SendInput（Windows），`route:pid` 直达进程 / 投递窗口消息 | 辅助功能（macOS） |
| `cua_type` | 输入文本（Unicode 走事件 payload，任意键盘布局/CJK/emoji 均可） | 辅助功能（macOS） |
| `cua_key` | 命名按键与组合键（`cmd+shift+t`、`return`、`left`、`f5`） | 辅助功能（macOS） |
| `cua_element` | 让元素自己执行动作：`press`/`setValue`/`focus`/`scrollToVisible`/`menu`/`list` | 辅助功能（macOS） |
| `cua_app` | 应用生命周期与直接驱动：`activate`/`quit`/`launch`/`openURL`/`reveal`/`menu`/`script` | 辅助功能（macOS）；`script` 在 macOS 另需自动化授权，在 Windows 默认关闭 |

### 角色词汇

控件树里的 `role` 是**平台自己的词汇**：macOS 报 `AXButton`，Windows 报 UI Automation 控件类型 `Button`。`roles` 过滤参数**两套都收**——带 `AX` 前缀的名字会被剥掉前缀并映射到对应类型（`AXTextField` → `Edit`、`AXStaticText` → `Text`、`AXLink` → `Hyperlink` 等），所以学过 macOS 名字的模型在 Windows 上照样能过滤。反向映射则不会做：让 Windows 的大纲假装成 AX 词汇，只会到第一个没有 AX 对应物的控件类型时露馅。

`cua_element` 的结果同理：macOS 报 `AXPress`，Windows 报真正执行的那个 pattern（`Invoke`/`Toggle`/`Select`/`Expand`），因为后者信息更多。

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

### Windows 上的坐标系

同一套约定，但**一个点就是一个物理像素**。引擎声明了逐显示器 DPI 感知 v2，所以 UI Automation 的矩形、`SendInput` 的坐标、`GetMonitorInfo` 的矩形、以及截图区域全都是同一个空间，不需要任何换算——包括 150% 缩放的笔记本屏。

因此 Windows 上的 `scale` 恒为 `1`，除非调用方用 `maxWidth`/`maxHeight` 显式降采样；降采样后 `scale` 仍然是从回来的图里量出来的。macOS 那套"密度需要标定"的问题在 Windows 不存在。

越界拒绝、跨屏归属的行为与 macOS 完全一致。Windows 上同样会裁剪并置 `clipped`，只是被裁的对象是显示器或窗口。

### 可靠性阶梯

插件在 system prompt 里显式要求模型按下列顺序选择手段，能用高层就不用底层：

1. `cua_app` — `activate` / `menu` / `openURL` / `quit` / `hide`：直接 API 调用，不碰指针（macOS 上还可再加 `script`：目标应用自己完成工作）
2. `cua_element` — 元素自执行动作，不存在"点偏"
3. `cua_type` + `element` — 聚焦该控件再输入，目标明确
4. `cua_click` / 不带 element 的 `cua_type` / `cua_key` — 合成输入，面向最前台，仅在无辅助功能界面时使用

### 操作后台应用

这是**一等公民场景**，而且它会改变"哪个机制才是对的"：

**读取完全不依赖焦点。** `cua_tree` / `cua_screenshot` / `cua_windows` 以及按窗口截图都直接寻址后台应用。窗口在别的屏、或被别的窗口盖住，照样能截到——Windows 的窗口截图走 `PrintWindow`，由窗口自己绘制，被遮住也成立。

**`cua_element` 是后台安全的操作方式，两个平台都成立。** 动作由目标应用通过自己的辅助功能接口执行，不需要任何窗口在最前台，也不会把焦点从用户手上抢走。

**`cua_type` 的行为因平台而异**，这是实测结论，不是推测：

| 调用 | macOS 后台窗口 | Windows 后台窗口 |
|---|---|---|
| `cua_element` + `setValue` | ✅ 写入成功，前台应用未变 | ✅ 写入成功（`ValuePattern`），前台应用未变 |
| `cua_type` + `element` | ✅ 写入成功（引擎先 AX 聚焦该元素，再按 pid 投递） | ⚠️ 先把窗口带到前台再输入（Windows 没有按进程投递按键的能力） |
| `cua_type` 不带 element | ❌ 报告 delivered=true，但**文本被后台应用丢弃** | ❌ 同样只打到最前台 |

macOS 上不带 element 时仍会按 pid 投递，只是应用会忽略——除非它自己的 AX 焦点已在目标控件上。Windows 上根本没有 `CGEventPostToPid` 的对应物，所以合成按键只有一条路，结果里报告的 `route` 永远是实际用过的那条。

**不要为了读取而激活应用。** 把它弄到前面会改变用户正在看的东西，而所有读取都不需要这么做。

**`cua_click` 的 `route: "pid"`** 在两个平台上都是"不动可见光标"的那条路，但机制不同：macOS 投递给进程，Windows 投递窗口消息（客户区坐标）。后者经典 Win32 控件认，读真实光标位置的应用（Chromium、UWP、多数 canvas UI）不认，结果里会写明。

## 构建

```sh
cd packages/dsh-plugin-cua
pnpm install
pnpm run build          # 编译原生引擎 + 打包插件
```

`build-engine.mjs` 按 `process.platform` 选工具链：macOS 走 SwiftPM，Windows 走 `dotnet publish`，其他平台跳过并打印说明（插件仍会加载并如实报告 `unsupported_platform`）。

产物：

- `lib/bin/cua-engine`（macOS 单文件）或 `lib/bin/cua-engine/cua-engine.exe`（Windows 目录）
- `lib/index.js` — 单文件 ESM 插件包（`@deepseek-ai/dsh-tools`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 保持 external，运行时由 harness 解析，保证服务实例同一性）
- `lib/types/*.d.ts` — 类型声明

构建 Windows 引擎需要 .NET 9 SDK。默认发布为**目录**（237 个文件、约 126 MB），机器上不需要装 .NET 运行时。这个默认值是**为了杀毒软件**而不是为了打包方便：`PublishSingleFile` 搭配 WPF 必需的 `IncludeNativeLibrariesForSelfExtract` 会让 exe 每次启动都往 `%TEMP%\.net\` 里写出若干原生 DLL 再从那里加载——那正是 dropper 的行为特征。两种可选形态：

| 构建 | 结果 | 代价 |
|---|---|---|
| 默认 | `lib/bin/cua-engine/` 目录 | 237 个文件 |
| `CUA_ENGINE_WIN_FRAMEWORK_DEPENDENT=1` | 单个 0.3 MB exe | 需要目标机器已装 .NET 9 桌面运行时 |
| `CUA_ENGINE_WIN_SINGLE_FILE=1` | 单个约 120 MB exe | **每次启动自解压到 `%TEMP%`** |

### 关于杀毒软件

插件做的是合成键鼠输入、读别的进程 UI 树、截屏——**行为上和远控木马无法区分**，任何终端防护都会注意到，这不是代码质量问题。能减少的是「打包方式带来的额外信号」，以及签名。

本机实测到的唯一一次拦截是 `Trojan:Win32/PowhidSubExec.B`，它命中的是**命令行**而不是二进制（`Resources` 字段是 `CmdLine:_…`，对 120 MB 的 exe 做按需扫描没有任何检出）。而插件的正式路径是 `node → cua-engine.exe` 直接 spawn，**不经过 PowerShell**；产品里唯一用到 PowerShell 的是 `cua_app` 的 `script`（默认关闭）。那次拦截来自我手工用 PowerShell 调引擎。

配了代码签名证书后构建会自动签名：

```powershell
$env:CUA_ENGINE_SIGN_PFX = 'C:\path\to\codesign.pfx'
$env:CUA_ENGINE_SIGN_PASSWORD = '…'
pnpm run build:engine
```

被误报时正确的做法是去 <https://www.microsoft.com/en-us/wdsi/filesubmission> 提交开发者误报，而不是加排除项——前者会对所有人生效。完整分析见 [docs/windows-backend.md](packages/dsh-plugin-cua/docs/windows-backend.md#antivirus-smartscreen-and-being-mistaken-for-malware)。

校验：

```sh
pnpm run typecheck       # tsc --noEmit
pnpm run check:schemas   # 用 harness 的校验器验证每个工具的入参/出参 schema
pnpm run validate:patch -- <cordis.patch.yml>   # 用 harness 自己的加载器验证一个 patch 文件（写进 profile 之前）
pnpm run smoke           # 端到端：加载插件 + 调用真实引擎
pnpm run smoke:writes    # 额外移动一次指针、按一次 shift（会有可见副作用）
```

## 安装（作为插件包安装）

这个包**声明了 `dsh.bundle`**，本身就是一个可被 DSH 插件管理器安装的组合包。在应用的**左侧栏 Plugins 页**（`ui-plugin-manager`；「设置 → Plugins」那个列表是只读的）里填这个包的**绝对路径**：

```
/path/to/packages/dsh-plugin-cua
```

插件管理器会把它装进**当前 profile**——也就是这个应用正在启动的那个 profile——并把它加成 profile 的一个 bundle 层；包内的 `cordis.patch.yml` 提供**一行**：插件本身，而引擎由插件在包内自行解析。**这一行里没有任何需要改的路径**——绝对路径在除作者那台机器以外的每台机器上都是错的；而且一条路径也不可能同时对两个平台成立（Windows 的引擎是目录 `lib/bin/cua-engine/cua-engine.exe`，macOS 的引擎是单文件 `lib/bin/cua-engine`）。

装完之后**重启应用**，并且在**新建的会话**里使用——见下方"已知行为"。

### 已知行为：工具在既有会话中不可见

> 完整排查记录见 [docs/case-study-tool-visibility.md](docs/case-study-tool-visibility.md)——包含四个我曾误判的结论和可复用的诊断手法。

工具由宿主启动时注册。**在那个宿主启动之前就已存在、之后被恢复的会话看不到它们**；新建的会话可以。实测：同一个宿主里，一个跨越多次重启恢复的老会话调不到工具，新建会话正常。

这不是本插件特有的问题——挂在 profile / bundle 层的工具都有这个特性。遇到"工具不在"时，先新建一个会话再判断。

### 为什么 bundle 只给一行

原生插件行与 MCP 行**同时存在**会让模型看到两套同义工具（`cua_*` 与 `mcp__cua__*`，共 24 个），所以只保留一行。

**保留的是原生插件行**，因为两者的差别都只在原生行上有正面意义：

- 工具名是短名 `cua_*`；
- **`writeApproval` 写操作审批只在这条路径上生效**——MCP 行由 `dsh-mcp-client` 承载，它不加载本插件，所以没有插件级写门槛，操作系统的授权是唯一那道门；
- **`ctx.computerUse` 的 provider 登记也只在这条路径上发生**，同一个原因：插件的 `apply()` 只在插件被加载时运行。

成本方面：MCP 行的长处是不经过插件层，而原生行连**路径**都不需要——它只写包名，引擎由插件在包内找到。想要 `mcp__cua__*` 这个名字、或要接 MCP provider，见下方"方式 A"，那条路需要一个逐平台不同的绝对路径。

## 手动接入（不用插件管理器时）

### 方式 A：MCP provider

引擎内置 MCP server 模式（`cua-engine --mcp`），通过 `dsh-mcp-client` 接入。工具在模型侧显示为 `mcp__cua__<name>`。

这条路子要用 `--mcp`，所以 `command` 必须是**绝对路径**，而且**逐平台不同**：Windows 是目录里的 `cua-engine.exe`，macOS 是单文件 `cua-engine`。在 `cordis.patch.yml` 里：

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

> 与 MCP 行的差别只有三点，都在插件这一层，与功能无关：工具名是短名 `cua_*`；`writeApproval` 写操作审批**只在这条路径上生效**（MCP 行由 `dsh-mcp-client` 承载，不经过插件的 `apply`）；`ctx.computerUse` 的 provider 登记**也只在**这条路径上发生，同一个原因。截图返回的是内联 base64，而不是写盘后的路径。



> **先确认要装进哪个 profile。** `~/.dsh/profiles/` 下每个目录是一个 profile，桌面应用只启动其中一个。装错的那个会被完整加载、12 个工具全部注册，但永远不会被用到——而失败表现是"工具不存在"，和一个加载失败的插件完全一样。别猜，从**正在跑的那个宿主进程**读出真实答案：
>
> - Windows：`Get-NetTCPConnection -LocalPort 19387 -State Listen | Select-Object -ExpandProperty OwningProcess` 拿到 pid，再 `Get-CimInstance Win32_Process -Filter "ProcessId=<pid>" | Select-Object -ExpandProperty CommandLine`——profile 目录就在 `dsh-desktop-host` 命令行里紧跟着打包的 dsh 目录（该进程的 `process.argv[3]`）。实测本机是 `C:\Users\howar\.dsh\profiles\desktop`。
> - macOS：`lsof -p <宿主 pid> | grep profiles`。
>
> `dsh --profile desktop …` 在两个平台上都会被拒绝（`profile "desktop" is managed exclusively by the Electron application`），所以这条判断只能来自进程本身，不能来自 CLI。

1. 把包放进 profile 的依赖里（`~/.dsh/profiles/<profile>/package.json`）：

   ```json
   { "dependencies": { "@deepseek-ai/dsh-plugin-cua": "link:/path/to/cua/packages/dsh-plugin-cua" } }
   ```

   然后在 profile 目录执行 `dsh plugin --profile <profile> add <包路径>`（等于在该 profile 目录里跑 `pnpm add`；插件管理器与它共用同一套包操作）。若该 profile 由桌面应用管理（名字就是 `desktop`，CLI 会直接拒绝），直接建符号链接即可——`node_modules/@deepseek-ai/dsh-plugin-cua` 指向包目录（junction 也行），与 profile 既有的链接方式一致。桌面应用启动时只会清理指向它自己旧链接目录（`.dsh-module-fallback`）的链接，手工建的链接不受影响。

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
           allowedScript: false        # 仅 Windows：是否允许 cua_app 的 script 跑 PowerShell
   ```

   `enginePath` 可以省略：插件会先找包内的引擎（macOS 是 `lib/bin/cua-engine`，Windows 是 `lib/bin/cua-engine/cua-engine.exe`），再找源码树里的调试构建。

3. 重启 harness，并新建会话：这一行是启动时应用的（macOS 上引擎二进制路径与系统授权也在那时定下来；Windows 没有授权要定，但工具同样只在启动时注册）。

## 权限（macOS）

引擎报告的状态来自 `AXIsProcessTrusted()` 与 `CGPreflightScreenCaptureAccess()`，`cua_status` 会直接告诉你缺什么、去哪里开。

| 权限 | 覆盖 | 授权对象 |
|---|---|---|
| 辅助功能 Accessibility | 控件树、点击、输入、元素动作、窗口操作 | 承载引擎的宿主进程（`DeepSeek Harness`，或从终端启动时的终端应用） |
| 屏幕录制 Screen Recording | 截图 | 同上 |
| 自动化 Automation | `cua_app` 的 `script`（Apple Event） | 按被控应用逐条授权，首次调用时弹窗 |

要点：

- 授权按 **responsible process** 归属，**不是按二进制**。实测：把同一个引擎复制成一个从未被授权过的全新文件名，它立刻报告的仍是 `true`——因为授权跟着"谁拉起了它"，而不是跟着可执行文件本身。推论有三条，都很实用：
  - **重建/移动引擎不会丢权限**（每次 `swift build` 的 cdhash 都不同，若按二进制归属就永远无法满足）。
  - **要在系统设置里勾选的是宿主应用**（你的情况是 `DeepSeek Harness`），不是 `cua-engine`，也不是你启动它的终端。
  - **从终端直接跑引擎，截图一定失败**。这条不是 bug，是同一套归属规则的另一面：终端拉起的引擎没有宿主应用的授权，而失败形态很隐蔽——ScreenCaptureKit 既不返回也不抛错，只是不再应答。所以 `lib/bin/cua-engine --call capture.screenshot` 这类手工验证**只能验证控件树和窗口，不能验证截图**；截图要在宿主里通过工具调用验证。这是 macOS 独有的问题：Windows 上截图走 GDI，终端里跑的引擎一样能截，所以 `make smoke` 只在 macOS 上默认跳过截图断言（`DSH_CUA_CAPTURE=1` 可强制打开）。
- `cua_status` 的提示会直接说出宿主应用名和 pid，照着它给的路径勾选即可。系统设置的列表里如果找不到该应用，用 `+` 从 `/Applications` 添加。
- 修改授权后必须**退出并重启**宿主应用才生效——macOS 只在进程启动时读取授权状态。
- 未授权时工具不会静默返回空结果：`window.list` / `tree.dump` 会显式报 `permission_denied`（否则 AX 会返回空属性集，看起来像"这台机器上没有窗口"）。
- `cua_app` 的 `script` 会在独立队列上跑，并受硬超时保护。首次调用可能弹出自动化授权对话框；如果无人应答，引擎不会把后续请求堆在这个线程后面，而是直接返回"上一个脚本仍在运行"。

## 权限（Windows）

**没有需要授予的东西。** Windows 把 UI Automation、屏幕捕获、输入合成都开放给每个进程：没有辅助功能开关，没有屏幕录制弹窗，`cua_status` 也没有可以让用户去打开的设置页。它就是这么如实报告的——`accessibility` 与 `screenRecording` 在会话未锁定时恒为 `true`。

唯一的真实限制是**提权**。引擎在 `cua_status` 里为此单列一个 `elevated` 字段，让模型在撞上"这个窗口够不到"**之前**就知道自己站在完整性边界的哪一边。macOS 上这个字段**刻意不出现**：同一个用户的两个进程之间没有这条边界，凭空填一个 `false` 会被当成实测值。实测结论如下（对着一个管理员权限的记事本，从未提权的引擎）：

| 操作 | 结果 |
|---|---|
| `cua_screenshot` / `cua_windows` / `cua_app activate` | ✅ 正常，不受完整性级别限制 |
| `cua_tree` | ⚠️ 只能读到窗口外壳，子节点被 Windows 扣住（结果里会带 `note` 说明） |
| `cua_type` / `cua_click` / `route:pid` | ❌ **被丢弃，而且不报错** |

最后一行是关键：**`SendInput` 返回的是「排入队列的事件数」，不是「送达的事件数」**——UIPI 在更底层把它们丢掉，什么地方都不上报（实测期间 stderr 全程为空）。所以「先发再查返回值」这种做法从根上不成立，它会让两个最常用的写工具报告成功而实际什么都没做。

引擎因此改成**发送之前先问**，因为事后问不出来：

- **指针**：检查落点下的窗口（`click`/`down`/`up`/`drag`/`scroll`）。单纯 `move` 不检查——光标移过提权窗口是允许的。
- **键盘**：检查**前台窗口**。这里有个容易搞错的点——Windows 没有按进程投递按键的能力，按键永远跟着焦点走，所以只检查「元素属于哪个进程」是不够的。焦点设完之后还要**核对焦点到底落在哪**，不一致就拒绝，否则文字会打进另一个应用而结果却说投递成功。
- **`cua_tree`**：提权窗口的树只有根节点，会附带 `note` 说明原因，不至于看起来像「这个应用没有界面」。

由此产生一个值得知道的后果：**提权窗口占据前台时，任何地方都打不了字**——未提权的引擎抢不回前台，每一次按键都会被丢弃。引擎会逐次如实报错，但实际解法是有人点一下鼠标。

三条出路：以管理员身份运行 harness（等于把管理员权限交给模型，是实质性的安全让步）；用 **UIAccess**（Windows 为这类工具准备的机制：签名 + 装到 `%ProgramFiles%` + manifest 写 `uiAccess="true"`，就能在**不提权**的情况下驱动提权窗口，代价是需要代码签名）；或者只操作引擎够得到的窗口。

### 这个边界是不对称的，而它弄丢过一个窗口

只挡住输入是不够的。**UIPI 限制的是窗口消息和输入注入，它对进程访问没有任何限制**——进程访问由对象 DACL 决定，而同一个用户拥有的进程，无论完整性级别如何都会通过自己的 DACL。实测：

```
pid=21664  TrafficMonitor        elevated, PROCESS_TERMINATE GRANTED
pid=20872  ArmourySocketServer   elevated, PROCESS_TERMINATE GRANTED
```

所以：发给提权窗口的按键会被丢掉，但对着它调 `TerminateProcess` **会成功**。引擎挡住了前者，却痛快地做了后者——代价是一个窗口：smoke 测试要关掉它自己启动的记事本，执行 `cua_app quit app=notepad force=true`，名字匹配落到了用户为这次排查开着的**管理员权限记事本**上，杀进程成功了。

两处错误，都已修：

**第一，生命周期动作的范围曾是「所有共享同一可执行映像的进程」。** 这条规则本意是让 `quit` 结束整个应用而不是其中一个进程（记事本有个辅助进程，浏览器有 broker 和每个标签页的渲染进程）—— 但「同一映像」同样会命中用户**独立启动的第二个副本**，而调用方对此毫无预兆。现在范围是**一个实例**：被点名的进程，加上与它构成父子关系、且共享同一映像的进程。记事本的辅助进程是它的**父进程**，浏览器的渲染进程是它的**子进程**，所以两个方向都要走；走到映像边界就停，这正是把独立启动的副本挡在外面的机制。实测：三个 `notepad.exe` 进程中两个构成窗口实例的链、一个无关，`quit` 恰好结束那两个，第三个存活。

**第二，生命周期动作没有完整性守卫。** 现在有了，而且是 fail-closed：只要调用会触及的任一进程完整性级别高于引擎，`quit` / `hide` / `unhide` 就带原因拒绝。终止一个用户刻意提权运行的进程，是拿模型的名义做提权，而且不可逆——关掉的窗口连同未保存的内容一起没了。

注意这个守卫**不是**在说「操作会失败」。它会成功，所以才必须拒绝。

另有两条实测结论值得记下来：

- **`WTSSessionInfoEx` 的 `SessionFlags` 不可用**。它文档上的 `0 = 已锁 / 1 = 未锁` 对普通交互进程并不成立——未锁的机器上它同样返回 0。锁屏检测因此改用 `OpenInputDesktop`，并做重试：两个错误方向并不对称，误报"未锁"只是让一张截图看着奇怪，误报"已锁"会让 `ready` 为 false 并停掉全部截图。
- **读窗口标题应该用 `GetWindowText`**，而不是发 `WM_GETTEXT`。对属于其他进程的顶层窗口，它直接返回窗口管理器已缓存的标题、根本不发消息，所以既更快又不受目标进程卡死影响。

## 写操作授权

插件划一条线：**读自由，写过门**。

- **读**（`cua_status` / `cua_apps` / `cua_windows` / `cua_tree` / `cua_screenshot`，以及 `cua_element action:list`）不额外询问——它们只观察机器，且操作系统已经自己把门了。
- **写**（`cua_click` / `cua_type` / `cua_key` / `cua_element` 的变更动作 / `cua_app`）先经过 `ctx.approval`，失败即拒绝（fail closed）。

`writeApproval` 三档：

| 取值 | 行为 | 适用 |
|---|---|---|
| `always` | 每次写操作都询问 | 会话能弹窗时的默认选择 |
| `session` | 每个写工具在会话内问一次，之后复用授权 | 减少打断 |
| `never` | 不询问，操作系统的授权即唯一门 | 会话审批策略为 `never`（无人应答）时**唯一可用**的档位，否则审批被自动拒绝会导致写操作全部失败 |

### `script` 在 Windows 上默认关闭

macOS 的 `cua_app action=script` 发的是 Apple Event，系统会把自动化授权**限定到一个具名目标应用**。Windows 的对应物是一段 PowerShell，它不受任何限定——用户能做的事它都能做。所以它由配置项 `allowedScript` 控制，默认 `false`；打开后插件会给引擎传 `--allow-script`。关闭时结果会说明如何启用，而不是静默失败。

## 引擎 CLI

引擎可以脱离插件单独使用，便于排查：

```sh
ENGINE=lib/bin/cua-engine              # Windows 上为 lib/bin/cua-engine/cua-engine.exe
$ENGINE --probe                                            # 打一条状态就退出
$ENGINE --call tree.dump --params '{"app":"Finder"}'       # 单次调用
$ENGINE --version
$ENGINE --help

# 有状态用法：同一次进程内，先取树，再按索引点它
printf '%s\n' \
  '{"id":1,"method":"tree.dump","params":{"app":"Finder","maxDepth":4}}' \
  '{"id":2,"method":"element.action","params":{"element":5,"action":"list"}}' \
  | $ENGINE
```

## 协议参考

方法：`engine.status`、`engine.permissions`、`engine.request_permissions`、`app.list`、`window.list`、`display.list`、`tree.dump`、`capture.screenshot`、`pointer`、`keyboard`、`element.action`、`app`。

错误码：`invalid_request`、`unknown_method`、`not_found`、`permission_denied`、`operation_failed`、`unsupported_platform`。插件用 `EngineError.code` 区分它们，`permission_denied` 会附带修复提示。

设计约定：

- `params` 类型错误一律报错，不做静默降级。坐标写成字符串会被拒绝，而不是退化成"点击元素中心"——后者会点错东西。
- 未知参数名也报错，并列出这个调用接受哪些参数。把 `maxDepth` 打成 `maxdepth` 时应该看到一条错误，而不是一份"预算被忽略了"的默认树。
- 落点必须在某块显示器上，否则报错并给出桌面实际范围。
- 同一个概念只有一个字段。截图区域曾经在请求结构里存在两个等价字段（`region` 与 `sourceRect`），调用方只填其中一个，于是 `region` 恒为 `[0,0,0,0]`；现在只保留 `region`。
- 需要索引寻址的调用在快照缺失或索引越界时显式失败，并提示重跑 `cua_tree`，绝不把旧索引套用到新元素上。
- 结果里文档化的字段始终存在（无值为 `null`），调用方不必用 `in` 判断。

## 测试

```sh
cd packages/dsh-plugin-cua
pnpm run check          # 类型 + schema + 冒烟（不产生可见副作用）
pnpm run smoke:writes   # 额外包含真实指针移动、按键，以及后台应用读写
```

macOS 上 `smoke:writes` 会真的启动 TextEdit、把前台让给别的应用、在**后台**写入并读回，同时断言前台应用没有被抢走。Windows 上它会启动记事本、分别用 `cua_element` 和 `cua_type` 写入并读回，然后关掉它并把前台还给原来的窗口；「后台输入」这一条只在 macOS 上断言，Windows 上会明确打印说明——因为 Windows 没有按进程投递按键的能力。

## 下一步

交接文档：[docs/HANDOFF.md](docs/HANDOFF.md)——待办清单、未验证的代码路径、以及每项的判断依据。
macOS 待办：[docs/HANDOFF-macos-native-row.md](docs/HANDOFF-macos-native-row.md)——native 行的工具结果从未在 macOS 的模型会话里出现过；这份是在 macOS 上把它验完的步骤与回报清单。
排查记录：[docs/case-study-tool-visibility.md](docs/case-study-tool-visibility.md)。

## 已知限制

- **只有 macOS 和 Windows 两个后端**。其他平台会加载插件，但所有引擎调用返回 `unsupported_platform`。
- **跨屏区域按最大重叠归属单块屏**。一块跨两块屏的区域不会被拼接成一张图；它由重叠面积最大的那块屏捕获，超出该屏的部分为空白/黑边。需要完整跨屏视图时分别截两块屏。
- **锁屏时不可用**。macOS 上 ScreenCaptureKit 会以 `-3811` 失败，且最前台应用会变成 `loginwindow`；Windows 上会切到锁屏桌面。两个后端都会显式报告 `the screen is locked`，`cua_status` 也会把 `sessionLocked` 标为 true 并让 `ready` 为 false，而不是把底层错误抛给模型。
- **控件树必然被预算截断**。浏览器、Electron 应用的树可达数万节点，因此默认节点上限 1200、深度 8、时间预算 8s。结果里的 `truncatedBy` 会说明是哪个预算触发的，据此收窄查询而不是假设"看全了"。
- **`cua_type` 走合成事件**，某些应用会丢弃过快的输入；必要时用 `perCharacterDelayMs` 降速。不带 `element` 时对后台应用无效（见上文表格）。
- **`route: "pid"` 的合成点击**对后台窗口能否生效取决于具体应用，不做保证；需要可靠的后台操作请用 `cua_element`。
- **窗口标题需要屏幕录制权限**，这是 macOS 的限制，不是实现选择。
- **`element.action` 的索引只在同一引擎会话内有效**。引擎空闲 10 分钟后退出，之后索引失效需要重新取树。**MCP 模式下引擎由 MCP 客户端托管**，生命周期随之而定。
- **截图只在宿主进程树内可用**。终端里直接跑引擎时，ScreenCaptureKit 既不返回也不报错，只是不再应答（授权按 responsible process 归属，见上文"权限"）。引擎对这种情况有 12 秒看门狗：到点会打印原因并以 75 退出，而不是永远挂住——挂住的引擎会连带堵死整台机器的截图通路，MCP 客户端的重连策略随后会拉起一个新引擎。控件树、窗口、应用列表不受影响，可以照常在终端验证。
- **连续截图有瞬时失败**。ScreenCaptureKit 在快速连续捕获时会间歇性报 `-3811`，引擎对这类错误做有限重试（3 次、递增退避）后才上报。
- **Windows 的滚动是量化的**。工具按像素描述 `dx`/`dy`，而 Windows 滚轮以 120 像素为一格；引擎取最接近的整格执行，并**报告实际应用的增量**，不会告诉模型发生了一次没发生的滚动。
- **Windows 的控件树角色名是 UI Automation 控件类型**（`Button`、`Edit`），不是 AX 角色名。`roles` 过滤两套都收，但结果里出现的就是平台自己的词汇。
- **Windows 上 `cua_apps` 的已安装列表来自开始菜单快捷方式与卸载注册表**，没有这两者的打包应用（部分 Store 应用）只有在其运行后才会出现在 `running=true` 里；它们仍可用 Application User Model ID 启动。
- **Windows 上提权窗口是够不到的，而且失败是静默的**。`cua_screenshot` / `cua_windows` / `activate` 正常，但读取控件树只能拿到外壳，输入会被 UIPI 丢弃。引擎改成了发送前先检查完整性级别，所以现在会明确拒绝而不是谎报成功；见上文表格与 [docs/windows-backend.md](packages/dsh-plugin-cua/docs/windows-backend.md)。
- **提权窗口占据前台时打字会全部被拒**。按键跟着前台窗口走，而未提权的引擎抢不回前台，所以这不是能以代码规避的状态——需要人点一下鼠标，或让 harness 提权运行。
- **未提权时，`quit` / `hide` / `unhide` 不会作用于提权进程**——即使系统允许。UIPI 不管进程访问，所以杀提权进程是**会成功**的；引擎选择拒绝，因为那是拿调用方的名义做提权，而且关掉的窗口不可逆。同理，`quit` 的范围是**一个实例**（被点名的进程 + 与它构成父子链的同映像进程），不是所有同映像进程——后者会误伤用户独立启动的第二个副本。
- **`cua_app` 按名字/`bundleId` 匹配到多个运行实例时会拒绝，而不是挑一个**。所有 `cua_app` 动作都会改变状态，而挑「pid 较小的那个」是调用方没做也看不见的决定；`quit` 尤其不可逆。拒绝信息里会列出候选的 pid 和窗口标题，用 `pid` 就能指定。注意**多进程的单个实例不算歧义**——记事本一个实例就占 2 个进程，浏览器几十个，所以判断的是「实例数」而不是「进程数」。
- **引擎未签名，会被终端防护注意到**。这类工具（合成输入 + 截屏 + 读别的进程 UI 树）行为上就是远控木马的样子，这不是能靠改代码消除的。构建侧已经去掉了最大的额外信号（不再自解压到 `%TEMP%`）并补全了版本信息；真正的解法是代码签名，见 [docs/windows-backend.md](packages/dsh-plugin-cua/docs/windows-backend.md#antivirus-smartscreen-and-being-mistaken-for-malware)。
- **`includeBackground: true` 会返回几十行系统辅助进程**（NVContainer、Runtime Broker、输入法组件等）。默认列表不受影响。这是为了让 `hide` 可逆而付的代价：应用查找必须包含有隐藏窗口的进程，否则隐藏之后就再也找不到。
- **`cua_apps` 按可执行文件路径分组，一行一个应用而不是一行一个进程**。浏览器、Electron 应用、记事本都是多进程，不分组的话同一个应用会重复出现（实测一台真实桌面：59 行只有 51 个不同应用）。分组键和 `cua_app` 判断「是不是同一个应用」用的是同一个，所以列表和生命周期动作对「一个应用」的理解一致。读不到映像路径的进程（`dwm`、SYSTEM 级服务，非提权读不到）会单独成行，`bundleId` 为空——这是 Windows 的访问控制边界，不去猜。
