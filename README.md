# dsh-session-toast

DSH（DeepSeek Harness）主机插件：**会话相关事件发生时弹出真正的 Windows 系统通知**。

切到别的窗口干活时，不用再盯着 DSH 看它跑完没有。

| 通知 | 触发接缝 | 文案示例 |
| --- | --- | --- |
| 会话完成 | `agent/status` `running → idle`，且该会话最后一条 `turn/end` 的 reason 为 `completed` | `DeepSeek Harness` / `已完成` / `修复登录 500` |
| 会话出错 | 同上，reason 为 `error` | `出错：Connection reset by peer` |
| 会话中止 | 同 reason 为 `aborted` | `已中止（user）` |
| 达到 token 上限 | reason 为 `max-tokens` | `达到 token 上限` |
| Agent 正在问你 | `user-questions/request` 瀑布 | `正在问你：要装到 desktop profile 吗？` |
| 等待你的审批 | `approval/request` 瀑布 | `等待你的审批：write` / `写入工作区之外` |
| 目标受阻 | `goal/changed` 且 `operation === 'block'` | `目标受阻：waiting on CI` |

通知由 **Windows 通知中心**承载：横幅 + 系统提示音，点开后留在通知中心可回看。显示名为 **DeepSeek Harness**，带官方鲸鱼图标。

**点击通知会把 DSH 桌面窗口带到前台**（最小化时恢复并聚焦，已有窗口不会被新开一个）。桌面壳注册了 `dsh` 协议（`HKCU\Software\Classes\dsh\shell\open\command` → `"...\DeepSeek Harness.exe" "%1"`），其 `open-url` 处理器用 `dsh://open` 触发 `focusPrimaryWindow()`；若窗口已被关闭，则会重新创建。

注意：**深链不带会话 id**。壳里 `open-url` 是拿 URL 和字面量 `dsh://open` 比较的，任何其它 URL 都被忽略，所以没有受支持的方式让通知直接跳到某个会话——点击只是把应用拉回前台。会话名写在通知正文里。

## 为什么是自研而不是装现成的

社区里有二十来个同类插件，但对 **DSH 0.2.0** 基本都装不上——不是功能不行，是撞上了 0.2.0 起的一道硬兼容门。

自 `0.2.0` 起，Host 对插件 manifest 中**所有** `@deepseek-ai/dsh` / `@deepseek-ai/dsh-*` 的 `peerDependencies` 做检查：

```js
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

不匹配则 `dsh plugin add` 直接拒绝；已经装上的行在启动时被跳过。`peerDependenciesMeta.optional` **不豁免**，`engines.dsh` 与 `dsh.compatibility` 运行时根本不读。

而社区插件几乎都写着 0.1.x 的范围（`^0.1.5-rc.2`、`^0.1.7-rc.2` 之类），它们**都不包含** `0.2.0-rc.1`。所以：

| 包 | 阻塞原因 |
| --- | --- |
| `dsh-task-notify` | `dsh-tools` / `dsh-session` / `dsh-settings` / `dsh-host-webserver` `^0.1.5-rc.2` |
| `dsh-task-notifier` | `dsh-client-runtime` `^0.1.1-rc.2` |
| `dsh-notify-ding` | `dsh` `^0.1.7-rc.2`、`dsh-client-ui-session` `^0.1.7-rc.2` |
| `dsh-notifier` | `dsh-session` 只列到 `0.1.7-rc.2` |
| `dsh-notify-me` | `dsh-client-locale` 上限 `^0.1.5-rc.1` |
| `dsh-my-notify` | `dsh-session-title` `^0.1.5-rc.2` |

少数没有 dsh peer 的能装（`dsh-notify`、`dsh-desktop-notify`、`dsh-win-notify` 等），但它们要么是**浏览器 `Notification` API**（页面必须开着、还要授权，不是系统弹窗），要么弹出的通知**署名是 "Windows PowerShell"**——因为它们借用了 PowerShell 的 AppUserModelID，而 Windows 只接受**已注册身份**发出的 toast。

本插件两处都做得更好，代价只是一段 PowerShell：

- **不对任何 `@deepseek-ai/dsh-*` 声明 peer**，兼容门永远碰不到它。所有协作者都通过 `ctx.get(...)` 在调用时可选查找，缺一个只降级一条接缝，不影响挂载。
- 用桌面版已经注册好的 AUMID **`com.deepseek.dsh`**，所以横幅显示 **DeepSeek Harness** 和鲸鱼图标；万一该身份不存在，再退回 PowerShell 的身份，宁可署名难看也不静默不弹。

## 安装

桌面 profile 的 `dsh` CLI 被 Electron 独占，**命令行装不了**，走应用内插件页或 `plugin_manager` 工具：

```
plugin_manager  install_bundle  target: "github:你的用户名/dsh-session-toast"
```

包声明了 `dsh.bundle.patch`，安装时 reconcile 会自动把它追加进 profile 的 `dsh.profile.bundles`，重启 DSH 即生效。

## 配置

所有开关都可以在 profile 的 `cordis.patch.yml` 用户层按 id 覆盖（**不要**再插一行同 id 的）：

```yaml
- id: session-toast
  name: 'dsh-session-toast'
  config:
    enabled: true                 # 总开关，false 时所有接缝静默
    onTurnEnd: true               # 回合完成/出错/中止/token 上限
    onQuestion: true              # Agent 提问等待回答
    onApproval: true              # 等待审批（提权/越权）
    onGoalBlock: true             # 目标受阻
    sound: true                   # 系统提示音
    aumid: 'com.deepseek.dsh'     # toast 归属身份
    powershellPath: ''            # 留空用 System32 里的 Windows PowerShell 5.1
    title: 'DeepSeek Harness'     # 通知标题行
    dedupeMs: 2000                # 同一事件的去重窗口
    suppressWhileGoalActive: true # goal 自动续跑时，只在受阻时提醒，不每轮打扰
    includeSubagents: false       # true = 子代理会话的回合也通知
    focusOnClick: true            # 点击通知把 DSH 窗口带到前台
    activationUri: 'dsh://open'   # 点击时打开的 URI；配合 focusOnClick: false 可让通知变成纯提示
```

字段都是 `.volatile()`，配合 Settings 页可热改，不必重启。

## 设计取舍

- **回合完成只在真正的结束点播报。** `agent/status` 的 `running → idle` 才是「这一轮彻底跑完」，卡片上每个中间态都不是。判断依据是该会话最后一条 `turn/end` 的 `reason`。
- **`interrupted` 与 `forked` 不通知。** 前者是持久化后端在重载时补写的崩溃尾巴，不是刚跑完的活；后者是分支点。
- **goal 自动续跑不刷屏。** goal 处于 `active` + `armed` 时，每轮答完都会 `idle`，而 goal 会立刻起下一轮。此时静默，「真正停下来」由 `goal/changed → block` 负责播报。想去掉这个行为就把 `suppressWhileGoalActive` 设为 `false`。
- **两个瀑布都只是旁听者。** `user-questions/request` 与 `approval/request` 是 waterfall：本插件弹完通知**必须**继续 `next()`。吞掉请求会让工具调用永久挂起——测试专门锁死了这一点。
- **动态文案一律走 base64。** 整段 PowerShell 程序以 `-EncodedCommand`（UTF-16LE base64）下发，标题/正文/身份各自再 base64 一层，在 PowerShell 里解码。引号、换行、非 ASCII、代码页都无法破坏通知内容。
- **弹窗不阻塞宿主。** `spawn` 带 `windowsHide: true`、`stdio: 'ignore'`、`detached` + `unref()`，失败只写一行日志，绝不冒泡进触发它的事件。

## 开发

```bash
npm test        # 35 项回归：回合判定、两个瀑布不吞请求、去重、容错、挂载契约
npm run smoke   # 真弹一条系统通知，验证这台机器的通道
```

`npm run smoke` 不需要 DSH、不需要网络，只需要 Windows。退出码 `3` 表示没有任何已注册身份接受该 toast。

## 平台

Windows 10/11。其它平台 `apply()` 照常挂载，只是弹窗会被 PowerShell 的缺失拒掉——请改用浏览器通知类插件。

## License

MIT
