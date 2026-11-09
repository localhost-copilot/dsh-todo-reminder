# dsh-todo

[English](README.md) | [简体中文](README.zh-CN.md)

长时间运行的 DSH 会话容易跑偏：模型写了一份 todo，干了五十步，就再没回头看过它。这个插件让清单留在视野里。它复用已有 `todo_write` 工具，只在清单长时间未更新时提醒模型，并在压缩后把当前未完成清单恢复到 DSH runtime context。不新增工具，不新增 turn，不额外存储。

## 前置条件

- Node.js ≥24.9
- profile 中已提供 `todo_write`、tools、session-projection、system-prompt 服务

已验证 Desktop 随附的 DSH 0.2.1-rc.2、已安装 CLI 的 0.2.2-rc.1，以及相邻 `deepseek-harness` 源码。

## 安装

1. 在 checkout 内安装依赖：

   ```sh
   cd <path-to-dsh-todo>
   npm ci
   ```

2. 以 link 方式注册到 profile：

   ```sh
   dsh plugin --profile <profile> add link:<path-to-dsh-todo>
   ```

将 `<profile>` 替换为实际使用的 profile 名。插件通过 `dsh.bundle.patch` 加载；仅在 profile 目录执行 `pnpm add` 不保证启用 bundle。如果已启用旧的 `@bewaremypower/dsh-todo-reminder`，先移除旧插件，避免重复提醒和相同 entry ID 冲突。

`desktop` 是 Electron 专属管理的 profile，安装入口是 Desktop 的 Plugins → Add plugin，填写同一个 `link:<path-to-dsh-todo>` 地址。CLI 会拒绝 `dsh plugin --profile desktop`。

在 `dsh-TUI` 中使用时，安装到其 DSH 后端实际选用的 profile。插件没有额外的 TUI 面板：清单沿用现有 todo 展示，提醒作为模型可见的 notice 注入。Claude/Codex 等其他后端不运行这些 DSH hooks。本项目尚未进行 TUI 界面实测。

## 行为

- 只根据成功提交的 `todo/write` 更新清单；失败或被拒绝的工具调用不重置计数。
- 每条非空、非纯 reasoning 的已提交 assistant 响应计一步；一次响应中的并行或嵌套工具调用不额外计数。失败的模型尝试、工具结果、压缩替换副本不计数。
- 距上次成功写入至少 10 步**且**距上次提醒至少 10 步时提醒；后续每隔至少 10 步可再次提醒。两个阈值均可配置。
- 从未创建、已清空或全部完成的清单不提醒。真实用户消息给予新的宽限期。`turn/start` 清空清单状态，与 DSH todo 工具一致。
- 在下一次已获准的模型请求前添加提醒，由 agent loop 记录为 `user/message`。拒绝的步骤、已取消的请求、没有获准使用 `todo_write` 的步骤不添加提醒。
- 当前清单通过 `systemPrompt.context()` 贡献给 DSH：清单变化或压缩移除快照后，由 DSH 重新记录；内容不变时由 DSH 去重。最多显示 20 个未完成项，每项描述最多 240 个 UTF-16 code units，额外项目显示数量。
- 提醒允许模型保持准确清单不变。插件不发起新 turn，不阻止结束，也不自动完成、删除或取消任务。

## 配置

可在 profile 的 Cordis patch 中覆盖 bundle entry：

```yaml
- id: todo-reminder
  config:
    staleAfterSteps: 10
    repeatEverySteps: 10
    restoreContext: true
```

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `staleAfterSteps` | `10` | 距上次成功写入多少步后，清单视为过期。 |
| `repeatEverySteps` | `10` | 清单过期后，两次提醒之间至少间隔多少步。 |
| `restoreContext` | `true` | 通过 `systemPrompt.context()` 贡献清单。设为 `false` 保留提醒、关闭快照。 |

两个间隔都必须是正安全整数，且首次提醒需同时满足两个间隔。例如 `staleAfterSteps: 5`、`repeatEverySteps: 10`，首次仍至少等待 10 步。

## 状态与扩展范围

`src/projection.js` 注册一个 host-only projection，纯函数重放已提交事件，得到清单及两个计数。DSH 负责 checkpoint、恢复和事件驱动更新。projection 是派生缓存，`todo/write` 仍是唯一清单来源；没有额外文件存储，也不调用已弃用的同步历史扫描 API。

`index.js` 在 DSH 0.2.2 中使用每次组装时已解析的 tool set 检查可用性；0.2.1 尚无 step-time admission，使用该版本 tools registry 的可见性。projection 同样兼容 0.2.1 的注册 disposer 与按 key 读取接口、0.2.2 的异步 reader handle。pre-step waterfall 保留下游的拒绝、消息及 request-series 标记。普通 reminder 和“直到目标完成才停止”的执行控制各自独立；本项目只实现前者。

设计参考 CC 恢复源码中的双计数提醒，以及 Grok 的压缩后任务快照。结束时的 TodoGate、OpenCode Goal 等持续执行机制不在当前功能范围内。

## 开发与验证

```sh
npm run check
DSH_SOURCE=/absolute/path/to/deepseek-harness npm run test:integration
DSH_RUNTIME='/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh' npm run test:integration
npm pack --dry-run
```

`check` 执行语法检查和独立行为测试。集成测试需要已安装依赖（含 tsx）的 DSH 源码，默认查找相邻 `../deepseek-harness`。测试启动器仅在子进程中将 workspace 包解析到源码；checkout 缺失的 zod 链接回退到本项目已安装的依赖，不修改 harness 文件或 node_modules。

`DSH_RUNTIME` 模式直接使用安装目录中的运行库，无需 tsx 或源码。源码模式与两个安装版本运行同一组集成测试。

集成测试使用真实 agent loop、session、projection registry、todo 工具及工具执行器，只模拟模型和读取工具。验证并行调用计数、提醒实际进入请求和日志、失败写入、中途卸载重载，以及快照替换后恢复。通过的源码版本为 `fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159`，安装版本为 Desktop 0.2.1-rc.2 和 CLI 0.2.2-rc.1；这些测试无需 API key，只能证明链路正确，不代表真实模型一定遵循提醒。
