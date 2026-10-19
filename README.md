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

**新环境**（首次安装）：

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

### 源码目录与「改完即生效」

本仓库就是**安装源**。怎么让改动生效，取决于当初怎么装的：

| 装法 | 机制 | 之后再改源码 |
|---|---|---|
| `dsh plugin add file:<源>` | pnpm 把文件**复制**进 `.pnpm` 存储，再在 `node_modules` 建符号链接 | ❌ **不会自动同步**，得重新装一次 |
| `node_modules` 里放**目录联接**指向源目录 | Node 穿透解析到真实路径 | ✅ **立刻生效**，改完刷新页面/重启即可 |

两种都行。想要「改完即生效」，用联接：

```powershell
# 先删掉 pnpm 装出来的那份，再建联接
$nm = "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-per-model-temperature"
Remove-Item $nm -Recurse -Force
New-Item -ItemType Junction -Path $nm -Target "C:\llmProj\modelConfig\dsh-per-model-temperature"
```

或者直接用脚本，它把上面这些连依赖检查、失败回滚一起做了：

```bash
node scripts/relink.mjs
```

**⚠️ 用联接有个前提**：Node 会从**真实路径**（而不是联接路径）往上找依赖，所以源目录**必须自带 `node_modules`**，否则 `@deepseek-ai/schemastery` 解析不到、插件加载直接失败：

```powershell
cd C:\llmProj\modelConfig\dsh-per-model-temperature
npm install --omit=dev
```

（`node_modules/` 已在 `.gitignore` 里，不会进仓库。）

---

## 更新 dsh 之后（必读）

**每次 `dsh` 更新完，先跑这个：**

```bash
node scripts/check-compat.mjs
```

一条命令查 23 项，覆盖本插件依赖的每一个上游接口。全绿才算好；有红它会直接告诉你该做什么。

### 为什么需要这一步

本插件站在一条**上游并不保证**的缝上：老式 settings API，也就是 `ctx.settings.register()`。

- dsh `0.2.1-alpha.5` 起，上游的 `dsh-settings` 只剩**新式表单模型**（插件自己的 volatile Config），**`register()` 已经不在上游代码里了**；
- 本机是靠 **`dsh-purge` 的 #42 号补丁 `SETTINGS_LEGACY_API`** 把它加回来的 —— 该补丁不仅补回 `register()`，还把 legacy 命名空间接进了 `describe()`（客户端读表单）和 `mutate()`（客户端写表单）。

于是就有了这个失败模式：

```
dsh update  →  覆盖 node_modules 里的文件  →  补丁被冲掉
           →  ctx.settings.register 变成 undefined
           →  插件的 apply() 抛 TypeError
           →  服务端监听器没挂上、设置页没有数据源
           →  表现：插件「失效」，不报错、不崩溃、没日志
```

### 怎么修

1. **重新打补丁** —— `dsh-purge` 的 `purge_apply`（#42 等）；
2. **重启 dsh** —— 补丁改的是磁盘文件，运行中的进程还持有旧模块，必须重启才吃得到；
3. **恢复链接**（用联接方案的话）—— 更新会重跑安装，把链接换成副本：
   ```bash
   node scripts/relink.mjs
   ```
4. `node scripts/check-compat.mjs` 确认全绿。

`check-compat.mjs` 的最后一条专门验这个：**运行中的 dsh 进程启动时间是否晚于补丁写入时间**。补丁打了但没重启，这条会红。

### 为什么链接会被冲掉

profile 用 `file:` 依赖装这个插件，pnpm 的做法是**复制**源目录。于是每次 `dsh update` 都会重跑安装：

```
你把 node_modules 建成指向源目录的联接（想要「改完即生效」）
        ↓
dsh update → pnpm 重新安装 → 联接被真实副本覆盖
        ↓
改动不再同步 —— 而且无声无息，没有任何报错
```

`relink.mjs` 就是干这个的：检测并恢复，幂等、可 dry-run。

```bash
node scripts/relink.mjs            # 检查并在需要时重建
node scripts/relink.mjs --dry-run  # 只看会做什么
```

它会先确认**源目录自带 `node_modules`**（链接生效后 Node 从真实路径找依赖，缺了会加载失败），换链接前把旧目录挪成 `.pmt-copy-backup`，建好后再真 import 一次验证；任一步失败会自动回滚。

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

六个脚本，都不需要浏览器：

```bash
node scripts/check-compat.mjs             # 23 passed, 0 failed  ← dsh 更新后先跑这个
node scripts/relink.mjs                   # 更新后若变成实体副本，用它接回源目录
node scripts/test-temperature-client.mjs  # 74 通过 / 0 失败
node scripts/probe-apply-temperature.mjs  # 15 passed, 0 failed
node scripts/probe-directory.mjs          # 13 passed, 0 failed
node scripts/probe-live-record.mjs        # 15 passed, 0 failed
```

- **`check-compat.mjs`** —— 兼容性哨兵。逐条验上游接口：`dsh-settings` 的 legacy API 是否在（**本次失效的根因**）、`describe()`/`mutate()` 是否接了 legacy 命名空间、`agent/request` waterfall 是否还在、`temperature` 能否活着穿过 `resolveCallWithInfo` 与 pi-ai 转发层、配置数据是否还在、磁盘副本是否与源码一致、**运行中的 dsh 是否启动于补丁之后**。断了会直接给出该做什么。
- **`test-temperature-client.mjs`** —— 用最小 React 桩把 `client.js` 真跑起来。覆盖「点添加没反应」、「三个字段都是下拉」、「换提供商必须清空模型」、「自定义标记不能串行」、「点菜单滚动条不能把菜单关掉」等曾经真踩过的坑。
- **`probe-apply-temperature.mjs`** —— 把**已安装的那份** `index.js` 当真模块 import 进来，驱动真实的 `apply()` 监听器，验命中/不命中/多行并存/不改写入参。
- **`probe-live-record.mjs`** —— 端到端：用 **harness 自己的 yaml 解析器**读真实的 `settings-legacy.yaml`，过**真实的 `settingsSchema`**，再进真实监听器，证明磁盘上那条记录真的会变成发出去的 `temperature`。
- **`probe-directory.mjs`** —— 验服务端把**活路由表**（`llm.listProviders()`，同步）和**每个路由的模型**（`llm.listModels(route)`，**异步**）发布进设置文档，覆盖「运行时注册的路由也要能选」。含幂等、「某个路由取模型抛错不影响其它」、「宿主不提供 llm 时不抛错」。
- **`relink.mjs`** —— 把 `node_modules` 里那份插件接回源目录。dsh 更新会重跑安装、把链接换成副本，跑它恢复。「改完即生效」靠的就是这个链接。

### 下拉里为什么会有插件自己的路由

`dsh-our-free-model`、`@opencode2dsh/dsh-plugin` 这类插件用 `ctx.llm.registerAdapter()` 在**运行时**注册路由，它们**不在** `llm-pi-ai` 的静态 `providers` 段里。设置页的路由来源有三个，按可信度排：

1. **`routes` / `models` 字段** —— 服务端在启动时（以及 `llm/adapters-updated` 时）把活目录写进本插件自己的设置文档。这是主通道：客户端本来就在读这份文档，不依赖 remote API。
2. **remote 目录** —— `llm/listProviders` + `session/modelCatalog`，能拿到就用，拿不到就跳过。
3. **静态 `llm-pi-ai` 段** —— 兜底，只含手写声明的路由。

三个都没有的部署，下拉末尾还有「自定义提供商…」可以手敲 —— 但正常情况下用不到它。

`npm test` 会把四个一起跑。三个探针优先读**已安装副本**（`$DSH_HOME/profiles/<profile>/node_modules/...`），读不到才回退到源码目录；可以用 `DSH_HOME` / `DSH_PROFILE_DIR` / `DSH_PACKAGE` 环境变量指到别的部署。

---

## 兼容性

- 对 `@deepseek-ai/dsh` 声明 `>=0.2.0`（optional peer，缺了也不会拦你装）
- 在 **0.2.1-alpha.4** 上实测通过
- 依赖 `@deepseek-ai/schemastery` 定义设置段

## License

MIT
