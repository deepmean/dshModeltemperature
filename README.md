# dsh-per-model-temperature

给 [DeepSeek Harness](https://github.com/deepseek-ai/dsh) 用的**按模型温度**插件：在设置页里给每一条 `llm-pi-ai` 路由的每个模型单独配一个 `temperature`，并在请求真正发出去之前把它塞进去。

一个设置页 + 一个 `agent/request` 监听器，没有别的。

---

## 为什么非得是个插件

DSH 的 provider / model 配置里**没有** `temperature` 这个字段 —— 它能配 `reasoningEfforts`、`contextWindow`、`maxTokens`、`input`、`compat`、`headers`……就是没有温度。

而温度在链路上其实是通的，缺的只是「谁来决定它」：

```
GenerateOptions.temperature
  → LlmCallConfig.temperature
    → pi-ai StreamOptions.temperature
      → dsh-llm-pi-ai 转发进请求体
```

问题出在**生产者**：agent loop 播种请求提案（`seedConfig`）时只带 `provider` / `model` / `reasoningEffort` / `maxTokens`，**没有任何环节会产出 `temperature`**。

唯一的缝是 `agent/request` waterfall —— 而它交给监听器的提案是 **deep-frozen** 的：

```js
const proposedConfig = await this.dispatch.waterfall(
  'agent/request', { turn, step, signal },
  () => Promise.resolve(seedConfig),
)
```

所以监听器不能就地改，必须**返回一个新对象**。本插件做的就是这件事。

---

## 行为

按 **`provider` + `model` 精确匹配**，每次请求重新判定：

| 情况 | 结果 |
|---|---|
| 命中，且配了温度 | 注入该温度 |
| 命中，但温度留空 | 移除 `temperature`，走上游默认 |
| 没命中 | 移除 `temperature`，走上游默认 |

第三行是关键：提案会带上**上一个 step 留下的值**。如果只做「命中就注入」，那么一个为模型 A 配的温度会在会话中途切到模型 B 时**跟着过去**；同理，清空配置后旧值也会赖着不走。所以不命中时是主动**清掉**，而不是放着不管。

---

## 安装

> **这个包不在 npm 上，也不打算上。** `package.json` 里是 `"private": true`，
> 分发方式是 clone 仓库 + 本地 `file:` 安装。

```bash
git clone https://github.com/deepmean/dshModeltemperature.git
dsh plugin --profile web add "file:/绝对路径/dshModeltemperature"
```

或者手工两步：

1. 在 profile 的 `package.json` 里加依赖：
   ```json
   { "dependencies": { "dsh-per-model-temperature": "file:/绝对路径/dshModeltemperature" } }
   ```
2. 把它加进 `dsh.profile.bundles` 数组（顺序即加载顺序）。

插件自带 `cordis.patch.yml`，装载时会插入自己的配置行，不用你再写一遍。

---

## 用法

设置页里会多出一节 **per-model-temperature**。每一行三个下拉：

- **提供商** —— 选项来自**活的** `llm-pi-ai` 路由表，不是写死的
- **模型** —— 跟着选中的提供商过滤；选完提供商再换提供商，模型会自动清空（旧模型属于另一条路由）
- **温度** —— 预设 `0 / 0.2 / 0.3 / 0.5 / 0.7 / 0.9 / 1 / 1.2 / 1.5 / 2`，加一个「自定义…」

「自定义…」会把那一格变成输入框，**在你填完失焦之后**才落库 —— 所以中途不会写出半截值。留空 = 不下发，交回给上游默认。

存量值不会丢：不在预设里的温度（比如 `0.35`）会照原样渲染成输入框；配置里已经删掉的路由，那一行也仍然可见、可删。

---

## 生效时机（重要）

改了东西要做什么，取决于你改的是哪一层：

| 改什么 | 怎么生效 | 要重启吗 |
|---|---|---|
| 温度值（设置页里改） | **立刻**，下一次请求就读到 | 不用 |
| 温度值（**手工编辑** `settings-legacy.yaml`） | **不生效**，而且会被覆盖 —— 见下 | 不用，但也没用 |
| `client.js`（界面） | 刷新页面 | 不用 |
| `index.js`（服务端逻辑） | 复制进 profile 的副本后重启；或借 HMR 在下一次 profile 重新组合时替换 | 视路径 |

两点说明：

**一、温度只能走设置页改，别去手改那个 yaml。**
`dsh-settings` 的 `ensureLegacyDocument()` 是 `if (this.legacyDocument) return` —— **只在启动时读一次**，之后一直用内存里那份；而 `persistLegacy()` 会把**内存里那份**写回文件。你手改的内容不但读不到，还会在下一次保存时被直接盖掉。

**二、服务端代码不是改完就自动重载的。**
dsh 自带 HMR（`dsh-base/cordis.patch.yml` 里的 `hmr` 行，web 部署下默认启用），但它的 `root: []` 表示**不监听源码目录**。它替换的是「profile 目录下已加载文件在磁盘上发生变化」的插件，触发时机是**下一次 profile 重新组合**（profile manifest、两份用户 patch、或 Plugin Manager 操作）。所以最稳的做法还是：改完 → 复制进 profile 的 `node_modules` 副本 → 重启。

---

## 为什么没有 `top_p` / `top_k`

因为它们**在链路里根本不存在**：`GenerateOptions`、`LlmCallConfig`、两个 adapter 里都没有这两个名字，而且提案在派发前就被 deep-frozen 了 —— 插件没有任何缝可以往里加字段。要做这个，得先改 harness 本身。

同理，本插件**只管温度**：推理档位和输入模态住在 provider 自己的 `llm-pi-ai` 段里，harness 已经有编辑入口；在这里再写一遍会出现两个写同一个键的人。

---

## 测试

三个脚本，都不需要浏览器：

```bash
node scripts/test-temperature-client.mjs   # 60 通过 / 0 失败
node scripts/probe-apply-temperature.mjs   # 15 passed, 0 failed
node scripts/probe-live-record.mjs         # 15 passed, 0 failed
```

- **`test-temperature-client.mjs`** —— 用最小 React 桩把 `client.js` 真跑起来。覆盖「点添加没反应」、「三个字段都是下拉」、「换提供商必须清空模型」、「自定义标记不能串行」、「点菜单滚动条不能把菜单关掉」等曾经真踩过的坑。
- **`probe-apply-temperature.mjs`** —— 把**已安装的那份** `index.js` 当真模块 import 进来，驱动真实的 `apply()` 监听器，验命中/不命中/多行并存/不改写入参。
- **`probe-live-record.mjs`** —— 端到端：用 **harness 自己的 yaml 解析器**读真实的 `settings-legacy.yaml`，过**真实的 `settingsSchema`**，再进真实监听器，证明磁盘上那条记录真的会变成发出去的 `temperature`。

两个探针优先读**已安装副本**（`$DSH_HOME/profiles/<profile>/node_modules/...`），读不到才回退到源码目录；可以用 `DSH_HOME` / `DSH_PROFILE_DIR` / `DSH_PACKAGE` 环境变量指到别的部署。

---

## 兼容性

- 对 `@deepseek-ai/dsh` 声明 `>=0.2.0`（optional peer，缺了也不会拦你装）
- 在 **0.2.1-alpha.4** 上实测通过
- 依赖 `@deepseek-ai/schemastery` 定义设置段

## License

MIT
