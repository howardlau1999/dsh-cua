# 交接：让 `cua_*` 工具在这台机器上生效

**本文档针对本机（Windows，`C:\Users\howar`）的桌面应用，用中文写，与仓库其它英文文档分开。**
项目状态见 [`HANDOFF.md`](HANDOFF.md)，宿主内验证步骤见 [`../VERIFY-IN-HOST.md`](../VERIFY-IN-HOST.md)。

## 一句话现状

**装完了，也验完了。** 插件装在桌面应用真正启动的那个 profile（`desktop`）里，2026-09-23
重启应用后，一个新会话已经把 **12 个 `cua_*` 工具全部调到**（这一步当时写着"只能由人完成"）。
复验命令、期望值、以及那次验证发现的一个插件缺陷都记在下面。

## 验证记录（2026-09-23 重启后）

重启 → 新建会话 → 依次调用，全部通过。当时的原话：

| 工具 | 实测 |
|---|---|
| `cua_status` | engine `0.2.0`、backend `windows-uia`、UI Automation access 与 Screen capture 均 granted、屏幕 unlocked、`ready: true` |
| `cua_displays` | 1 台显示器，桌面 `[0,0,3840,2160]` |
| `cua_windows` | 1 个窗口（前台为应用自身），id 与屏幕矩形正常 |
| `cua_tree` / `cua_apps` / `cua_screenshot` / `cua_click` / `cua_type` / `cua_key` / `cua_element` / `cua_app` | 全部可用 |

配套维护检查（本轮实测）：

```
宿主进程命令行      → ...\dsh\...\lib\index.js ... C:\Users\howar\.dsh\profiles\desktop ...
两条 junction       → 均 True
validate-patch.mjs  → documents: 1 / insertedRows 含 id: cua，exit 0
pnpm run check      → 46/46、128/128、68/68，all 4 stages passed (2 skipped on this platform)
```

### 一处与上表期望不符：`cua_status` 不报 `elevated`

上表原先要求 `cua_status` 报 `elevated: false`。**它没报**，而且这不是文档写错，是插件的缺陷：
引擎（`WinHost.PermissionStatus`）确实返回 `elevated`、`elevationAvailable`、`backendDetail`、
`sessionId`，但插件的投影 `toPermissionReport`（`src/shared.ts`）只保留了 macOS 也有的十二个
字段，把 `elevated` 丢了。结果是引擎的提示语里写着 "`cua_status` reports `elevated: false` here"，
而**模型看不到那个 false**——只有把 hint 原文当字符串读才碰得到。UIPI 是 Windows 侧最要紧的那条
边界（发往提权窗口的输入被丢弃、该窗口内容不进树），模型却拿不到判断自己站在哪一边的字段。

已修：`elevated` 作为**可选**字段贯穿 schema / 投影 / 渲染（macOS 不报就不出现，不拿 `false`
冒充"量过了"），并在 `smoke.mjs` 里加三条断言——其中一条拿工具输出与引擎原始报告逐字对齐，
这条对照正是原来 65 项检查全都缺的。现在 `pnpm run check` 是 `68/68`。

**修复随下一次应用重启生效**：`lib/index.js` 已重新构建，但当前会话里跑的是宿主启动时加载的
那一份。想在本会话里看到那行 `Engine elevation:`，重启即可。

## 第一次安装时的两步（已完成，留作以后重装的参照）

工具是在**宿主进程启动时**注册进工具注册表的。在宿主启动之前就存在、之后被恢复的会话
—— 包括写第一版文档时正在进行的那段对话 —— 拿不到它们。这是 profile / bundle 层挂载的
通用性质，不是本插件的毛病。完整排查记录（含四个曾经误判的结论）见
[`case-study-tool-visibility.md`](case-study-tool-visibility.md)。

所以：重启之后**不要接着用旧会话**，点「新建会话」再验证。以后重装、改动 profile 行、或升级
插件包之后，同样按这个顺序走。

### 第一步：重启应用

1. **完全退出** DeepSeek Harness（不是关窗口；确认任务管理器 / 托盘里 `DeepSeek Harness.exe` 进程已消失），再重新打开。
2. 原因：`cordis.patch.yml` 里那一行是**启动时**应用的。没有观察到它对已启动宿主热加载生效的证据（改完之后 profile 目录没有被重写、也没有新日志），所以重启是最可靠的路径。

### 第二步：新建会话并验证

新会话里依次调用：

```
cua_status
cua_displays
cua_windows
cua_tree
```

期望结果：

| 工具 | 期望 |
|---|---|
| `cua_status` | engine `0.2.0`、backend `windows-uia`、`accessibility: true`、`screenRecording: true`、`ready: true`（宿主重启一次之后，正文里还会多一行 `Engine elevation: standard token (not elevated)`） |
| `cua_displays` | 显示器列表（含几何与像素密度），以及桌面外框 |
| `cua_windows` | 窗口 id 与屏幕矩形 |
| `cua_tree` | 前台的 UI Automation 树（一行一个元素，带索引） |

`elevated: false` 是**正常**的，不是错误：这台机器上的引擎跑在标准令牌下，
Windows 的 UIPI 会丢弃发往**管理员权限窗口**的注入输入。要驱动提权窗口只有三条路：以管理员身份
运行 harness、使用 UIAccess（需要代码签名）、或者只操作引擎够得到的窗口。生命周期的
`quit` / `hide` / `unhide` 对提权进程是**主动拒绝**的（因为 `TerminateProcess` 反而会成功）。

## 12 个工具（新会话里应当全部可见）

`cua_status`、`cua_request_permissions`、`cua_displays`、`cua_apps`、`cua_windows`、`cua_tree`、
`cua_screenshot`、`cua_click`、`cua_type`、`cua_key`、`cua_element`、`cua_app`

## 重装 / 升级后再出现问题时：按顺序查

这套顺序在验证通过之前写的，验证通过之后仍然是唯一可靠的顺序；每一步都能单独排除一类原因。
（本轮已经按它跑过一遍，见上面的"配套维护检查"。）

**1. 确认真的是新会话。** 旧会话（含最初那条排查对话）无论重启多少次都不会出现工具。

**2. 确认 profile 是宿主真正启动的那个**（别凭记忆）：

```powershell
$hostPid = Get-NetTCPConnection -LocalPort 19387 -State Listen | Select-Object -ExpandProperty OwningProcess
Get-CimInstance Win32_Process -Filter "ProcessId=$hostPid" | Select-Object -ExpandProperty CommandLine
```

命令行里 `dsh-desktop-host\lib\index.js` 之后依次是 **打包的 dsh 目录** 和 **profile 目录**，
本机应当是 `C:\Users\howar\.dsh\profiles\desktop`。若这里指向别的目录，说明装错了地方
（这正是本次修掉的问题：原来那一行在 `web` profile 里，而 `web` 只有 CLI 会用）。

**3. 确认包链接在位：**

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-plugin-cua\lib\index.js"
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-plugin-cua\lib\bin\cua-engine\cua-engine.exe"
```

两条都应为 `True`。

**4. 用 harness 自己的加载器验证 patch**（不要用字符串匹配、不要只看"YAML 能解析"）。
仓库里带了脚本，它从已安装副本或源码树里取加载器：

```powershell
cd C:\Users\howar\Desktop\dsh-cua
node packages\dsh-plugin-cua\scripts\validate-patch.mjs "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml"
```

期望：`documents: 1`，`insertedRows` 里有一行 `id: cua` / `name: @deepseek-ai/dsh-plugin-cua`，
退出码 0。多个 YAML 文档、或者行名解析不出来，都会以非 0 退出并打印加载器的原话。

**5. 若应用起不来或自己做了恢复。** 应用内置了一个恢复动作（禁用第三方插件、备份 profile patch、
重启），它会把 `cordis.patch.yml` 备份成 `cordis.patch.yml.bak-<时间戳>`，并把 profile 的
`bundles` 重置为 `dsh-base` + `dsh-web-app`。若发生过这件事，说明这一行在启动时被拒绝了：
先按第 4 步确认 patch 合法，再确认链接指向的包里有 `lib/index.js` 与
`lib/bin/cua-engine/cua-engine.exe`。命令行形态的 harness 会把启动失败报告写进
`~/.dsh/logs/startup-*.log`（本机目前没有这个目录，所以别把它当成唯一线索）。

**6. 兜底：临时停用。** 把 `cordis.patch.yml` 恢复成备份（内容就是空的 `[]`），重启即可回到
装上插件之前的状态；应用一定能起来。

## 本次改动之一：本机 profile 的状态

| 路径 | 改动 | 备份 |
|---|---|---|
| `~\.dsh\profiles\desktop\cordis.patch.yml` | 新增 `cua` 行（原文件是空列表 `[]`） | `cordis.patch.yml.bak-cua-20260923-001258` |
| `~\.dsh\profiles\desktop\package.json` | `dependencies` 加 `"@deepseek-ai/dsh-plugin-cua": "link:C:/Users/howar/Desktop/dsh-cua/packages/dsh-plugin-cua"` | `package.json.bak-cua-20260923-001258` |
| `~\.dsh\profiles\desktop\node_modules\@deepseek-ai\dsh-plugin-cua` | 新建 junction → `C:\Users\howar\Desktop\dsh-cua\packages\dsh-plugin-cua` | 无（原本不存在） |

`cordis.patch.yml` 里那一行的配置与含义：

```yaml
- insert:
    - id: cua
      name: '@deepseek-ai/dsh-plugin-cua'
      config:
        writeApproval: never      # 本会话的审批是关闭的：always 会被自动拒绝，写操作一次也过不去
        screenshotDir: C:/Users/howar/.dsh/cua-screenshots   # 必须是绝对路径，插件不展开 ~
        idleShutdownMs: 600000    # 引擎空闲 10 分钟后退出，下次调用自动拉起
        allowedScript: false      # Windows 专用：cua_app 的 script 会跑 PowerShell，且不受单个应用范围约束
```

**没有改动**：`~\.dsh\profiles\web\`（仍保留原来的那一行，CLI 会话用得上）、插件源码本体
（`src/`、`native/`、`lib/` 一行未动）。

仓库里的改动（与 profile 无关，但同批做掉）：

| 路径 | 改动 |
|---|---|
| `packages/dsh-plugin-cua/scripts/validate-patch.mjs` | 新增：用 harness 加载器验证任意 patch 文件的小脚本（本文第 4 步用它）；`pnpm run validate:patch -- <file>` 亦可 |
| `packages/dsh-plugin-cua/package.json` | 注册 `validate:patch` 脚本 |
| `Makefile` | 原先写死的 `$DSH_HOME/dsh-runtimes/...` 在本机不存在、MSYS 下 `$(HOME)` 也不对，`make typecheck/check/plugin` 直接崩；改为"有运行时优先用、否则回退 PATH 上的 node/pnpm" |
| `VERIFY-IN-HOST.md`、`README.md`、`README.en.md`、`docs/HANDOFF.md`、`docs/case-study-tool-visibility.md`、`packages/dsh-plugin-cua/docs/windows-backend.md` | 文档修正（profile 判定、安装入口、计数、源码树、哈希等），详见各自 diff |
| `packages/dsh-plugin-cua/src/shared.ts`、`src/tools-observe.ts` | 让 `cua_status` 带上引擎上报的 `elevated`（可选字段，macOS 不受影响） |
| `packages/dsh-plugin-cua/scripts/smoke.mjs` | 三条 elevation 断言；`callTool` 现在也返回渲染后的正文，使"模型读到的散文"可以被断言 |

### 回滚

```powershell
$d = "$env:USERPROFILE\.dsh\profiles\desktop"
Remove-Item "$d\node_modules\@deepseek-ai\dsh-plugin-cua" -Force          # 删 junction，不会删到源包
Copy-Item "$d\cordis.patch.yml.bak-cua-20260923-001258" "$d\cordis.patch.yml" -Force
Copy-Item "$d\package.json.bak-cua-20260923-001258"    "$d\package.json"    -Force
```

然后重启应用。`Remove-Item` 对 junction 只删链接本身，但**不要**加 `-Recurse` 指向包目录去删。

## 已验证 / 未验证（写清楚，别混）

已验证（可复现）：

| 项 | 证据 |
|---|---|
| 引擎在本机可用 | `cua-engine.exe --probe` → engine 0.2.0、backend `windows-uia`、`accessibility`/`screenRecording` true、`ready` true、`elevated` false |
| 插件对真实引擎端到端可用 | `pnpm run smoke` **68/68**（真实窗口、真实截图、UIA 树、computer-use slot） |
| 组合层能解析并注册全部 12 个工具 | 用应用自带运行时（0.1.6-alpha.2）在临时 `DSH_HOME` 里启动**真实 desktop profile 文件的副本**，探针报 12 个 `cua_*` 全部注册 |
| patch 合法 | harness 自己的 `loadOverlayPatches`：1 个文档、1 行、name 正确 |
| 仓库检查套件 | `pnpm run check`：4 个 stage 全过（2 个 macOS-only 跳过）；schemas 46/46、MCP catalog 128/128、smoke 68/68 |
| **live Electron 宿主亲自加载这一行并注册工具** | 2026-09-23 重启后新会话调用全部 12 个工具成功（见开头的验证记录） |
| 宿主启动的确实是 `desktop` profile | `Get-NetTCPConnection -LocalPort 19387` 取出宿主 pid，读其命令行第 4 个参数为 `C:\Users\howar\.dsh\profiles\desktop` |
| 插件缺陷的回归检查有效 | 把渲染那一行停掉，`smoke.mjs` 的 "cua_status renders the elevation it carries" 立刻失败并打印正文；恢复后 68/68 |

未验证：

- **macOS 上的 native row**。macOS 的一切验证都走的 MCP 行；native 行的**工具结果**（文本投影、
  图片入库、写审批的拒绝措辞）从没有在 macOS 会话里出现过。在 macOS 上信任它之前，先开新会话走一遍。
  Windows 侧这一课已经上过了——就是它暴露了上面那个 `elevated` 被丢掉的缺陷。
- **本会话内看到修复后的 `cua_status`**。`lib/index.js` 已重建，但宿主启动时加载的是旧的一份；
  重启后正文应多出 `Engine elevation:` 一行。

## 两条容易踩的坑

- **不要同时装 MCP 行**（`cua-engine --mcp` 那条）。两行都在会让模型看到 24 个同义工具
  （`cua_*` 与 `mcp__cua__*`），README 手册里有说明，但只在需要 `mcp__cua__*` 这个名字时才用。
- **不要用 `dsh --profile desktop …` 做任何事**。启动器在两个平台上都会直接拒绝这个名字
  （`profile "desktop" is managed exclusively by the Electron application`），
  连 `dsh plugin --profile desktop add …` 也一样——所以这个 profile 的插件只能靠「左侧栏 Plugins 页」
  或手工链接来装。反过来说：想知道它到底启动了哪个 profile，唯一可靠的办法是读宿主进程的命令行。

## 相关文档

- [`../VERIFY-IN-HOST.md`](../VERIFY-IN-HOST.md) —— 在宿主内逐级验证的步骤（已按 Windows/macOS 分别写明）。
- [`case-study-tool-visibility.md`](case-study-tool-visibility.md) —— 「工具不在」的两种成因与排查手法。
- [`HANDOFF.md`](HANDOFF.md) —— 项目整体状态、测试与未完成项。
- [`../packages/dsh-plugin-cua/docs/windows-backend.md`](../packages/dsh-plugin-cua/docs/windows-backend.md) —— Windows 后端的行为与边界（提权、UIPI、坐标、捕获）。
