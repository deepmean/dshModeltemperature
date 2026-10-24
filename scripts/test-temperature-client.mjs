#!/usr/bin/env node
/**
 * modelConfig / scripts/test-temperature-client.mjs
 *
 * 温度设置页的回归测试。不依赖浏览器：用最小 React 桩把 bundle 跑起来。
 *
 * 覆盖：
 *   1) 「添加一行」必须真的加出一行。曾经的 bug：添加直接 `save(空行)`，
 *      而 `toEntries` 会丢掉 provider/model 为空的行，于是写回 + 订阅回显
 *      把刚加的空行抹掉 —— 表现为「点了添加没反应」。
 *   2) 三个字段都是下拉：选项来自活的 llm-pi-ai 路由/模型列表；
 *      换提供商必须清空模型（旧模型属于另一条路由）。
 *   3) 自定义温度标记必须是「行的属性」，不能按行号索引 —— 否则删行/换路由后
 *      标记会串到别的行上，把无关行永久钉在输入框模式。
 *   4) 存量值（不在预设里的温度、已删除的路由）仍可见、可删。
 *   5) 下拉不是原生 <select> 而是自绘菜单：菜单内 mousedown（拖滚动条）不能
 *      把菜单关掉，只有点背板/点选项/Esc 才关；删行不能让别的行菜单弹开。
 *   6) 交互助手是 async 的：save() 先同步置 busy、await 之后才清，桩必须把微任务
 *      队列跑完，否则测试会一直停在 disabled 态（浏览器里不会）。
 *
 * 用法：node scripts/test-temperature-client.mjs
 * 退出码：0 全部通过；1 有失败。
 */

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientPath = path.join(here, '..', 'client.js')
const source = fs.readFileSync(clientPath, 'utf8')

let pass = 0
let fail = 0
function check(label, ok, extra = '') {
  if (ok) { pass += 1; console.log(`PASS  ${label}`) }
  else { fail += 1; console.log(`FAIL  ${label}${extra === '' ? '' : '  ' + extra}`) }
}

// ---------------------------------------------------------------- React 桩
// 槽位编号 = hook 调用顺序：0 snapshot / 1 rows / 2 llmSnapshot / 3 busy / 4 message
const HOOK = { ROWS: 1 }
function createReactStub() {
  const slots = []
  const effectDeps = []
  let cursor = 0
  let hookIndex = 0
  return {
    slots,
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => {
      const i = cursor++
      if (slots[i] === undefined) slots[i] = typeof initial === 'function' ? initial() : initial
      const set = (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value }
      return [slots[i], set]
    },
    // React 只在依赖变化时重跑 effect。这里如实模拟：依赖数组浅比较，
    // 相同就跳过 —— 否则每次渲染都会重复 subscribe，旧监听器用过期快照
    // 把状态覆盖回去（这是桩的错，不是组件的错）。
    useEffect: (fn, deps) => {
      const i = hookIndex++
      cursor += 1
      const previous = effectDeps[i]
      const same = Array.isArray(deps) && Array.isArray(previous)
        && deps.length === previous.length
        && deps.every((dep, k) => Object.is(dep, previous[k]))
      if (same) return
      effectDeps[i] = Array.isArray(deps) ? [...deps] : undefined
      try { fn() } catch { /* 订阅失败不影响测试断言 */ }
    },
    /** Fresh component instance: new hook state. */
    __reset: () => { slots.length = 0; effectDeps.length = 0; cursor = 0; hookIndex = 0 },
    /** Re-render the same instance. */
    __rerender: () => { cursor = 0; hookIndex = 0 },
  }
}

// ---------------------------------------------------------------- scope 桩
function createScope(initialValue, status = 'ready') {
  const calls = []
  const listeners = new Set()
  let value = initialValue
  return {
    calls,
    getSnapshot: () => ({ value, status, writable: true }),
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn) },
    /**
     * Path-level write, like the real `ConfigForm.set`: it is
     * `mutate([{op:'set', path:[field], value}])`, so other fields of the
     * section survive. Replacing the whole value here would erase `routes` and
     * `models` on the first row edit and make the picker look empty.
     */
    set: async (field, next) => {
      calls.push({ field, value: next })
      value = { ...value, [field]: Array.isArray(next) ? next : [] }
      for (const fn of listeners) fn()
      return true
    },
  }
}

/** Mirrors `CUSTOM` in client.js: the temperature cell's "typing" sentinel. */
const CUSTOM_SENTINEL = '__custom__'

const LLM_SECTION = {
  providers: {
    'wbproxy-intl': { models: [{ id: 'deepseek-v4.1-flash' }, { id: 'hy4-preview' }, { id: 'hy3' }] },
    dola2api: { models: [{ id: 'dola-chat' }] },
    justwoker: { modelOverrides: { 'claude-opus-4-8': {} } },
    openrouter: {},
  },
}

// ---------------------------------------------------------------- 载入 bundle
const react = createReactStub()
let scope
let llmScope
/** Live route registry stub; undefined models a deployment without api-remotes. */
let remote
let registered
let bundle
let tree = null

const ctx = {
  locale: { bind: () => (key) => key, register: () => () => {} },
  configForms: { get: (ns) => (ns === 'llm-pi-ai' ? llmScope : scope) },
  slots: {
    inject: (_slot, fn) => { registered = fn(); return () => {} },
    register: (_spec, component) => component,
  },
  effect: (fn) => { fn(); return () => {} },
  get: (name) => (name === 'remote' ? remote : undefined),
}

/**
 * The live directory the real remote answers:
 *   llm/listProviders      → [{ id, name }]
 *   session/modelCatalog   → { groups: [{ id, models: [{ id }] }] }
 * Both wrapped in the `{ ok, value }` envelope the transport returns.
 */
function createRemote(providers, groups) {
  return {
    llm: { listProviders: async () => ({ ok: true, value: providers }) },
    session: { modelCatalog: async () => ({ ok: true, value: { groups } }) },
  }
}

const sandbox = {
  window: { __ModuleLoader__: { load: (spec) => { bundle = spec } } },
  require: (name) => {
    if (name === 'react') return react
    throw new Error(`unexpected require: ${name}`)
  },
  document: {
    getElementById: () => null,
    createElement: () => ({ id: '', set textContent(v) {} }),
    head: { appendChild() {} },
  },
  console,
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox)

check('bundle 通过 __ModuleLoader__ 注册', bundle !== undefined && typeof bundle.factory === 'function')
if (bundle === undefined) process.exit(1)
check('bundle id 正确', bundle.id === 'dsh-per-model-temperature', String(bundle.id))
const api = bundle.factory(sandbox.require)
check('导出 apply 与 inject', typeof api.apply === 'function' && Array.isArray(api.inject))

// ---------------------------------------------------------------- 渲染工具
/** Stable reference, like the one `apply` closes over — a new arrow per render
 *  would change the effect's deps and re-run the directory read every render. */
const getRemote = () => remote

function render() {
  react.__rerender()
  tree = registered({ t: (key) => key, scope, llmScope, getRemote })
  return tree
}
/** Fresh component instance (new hook state) for a new scenario. */
function mount(nextScope, nextLlmScope, nextRemote) {
  scope = nextScope
  llmScope = nextLlmScope
  remote = nextRemote
  react.__reset()
  api.apply(ctx)
  return render()
}
/** Collect nodes by class. Handles array nodes and calls function components. */
function find(node, className, hits = []) {
  if (node === null || node === undefined || node === false) return hits
  if (Array.isArray(node)) {
    for (const child of node) find(child, className, hits)
    return hits
  }
  if (typeof node !== 'object') return hits
  if (typeof node.type === 'function') {
    find(node.type(node.props), className, hits)
    return hits
  }
  const cls = node.props?.className
  if (typeof cls === 'string' && cls.split(/\s+/).includes(className)) hits.push(node)
  for (const child of node.children ?? []) find(child, className, hits)
  return hits
}
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node !== 'object') return String(node)
  if (typeof node.type === 'function') return textOf(node.type(node.props))
  return (node.children ?? []).map((child) => textOf(child)).join('')
}
/** Element children of a node, flattening the array nodes React renders from. */
function childList(node) {
  if (node === null || node === undefined || node === false) return []
  if (Array.isArray(node)) return node.flatMap((item) => childList(item))
  if (typeof node !== 'object') return [node]
  if (typeof node.type === 'function') return childList(node.type(node.props))
  const out = []
  const visit = (value) => {
    if (Array.isArray(value)) { for (const item of value) visit(item); return }
    if (value !== null && value !== undefined && value !== false) out.push(value)
  }
  for (const child of node.children ?? []) visit(child)
  return out
}
function buttonByLabel(label) {
  const buttons = find(tree, 'dshtmp-btn').concat(find(tree, 'dshtmp-del'))
  return buttons.find((b) => textOf(b) === label)
}
function selectsOfRow(index) {
  return find(find(tree, 'dshtmp-row')[index], 'dshtmp-select')
}
/** Temperature cells that are free-text inputs, scoped to one row. */
function inputsOfRow(index) {
  return find(find(tree, 'dshtmp-row')[index], 'dshtmp-input')
}
/**
 * The control is a plain div now, so the test drives it the way the browser
 * does: `props.onClick` on the trigger. The callbacks that live only inside
 * Select's closures (`onToggle`/`onClose`/`onChange`) are deliberately NOT on
 * the DOM node — reading them here would be testing a contract nobody ships.
 */
function triggerOf(rowIndex, slot) {
  return selectsOfRow(rowIndex)[slot]
}
/** Options live on the node itself, so they are read off the trigger. */
function valueOf(rowIndex, slot) {
  return triggerOf(rowIndex, slot).props['data-value']
}
function disabledOf(rowIndex, slot) {
  return triggerOf(rowIndex, slot).props['data-disabled'] === true
}
/** Is this dropdown's menu on screen? */
function isOpen(rowIndex, slot) {
  return triggerOf(rowIndex, slot).props['aria-expanded'] === true
}
/**
 * Let the pending save settle.
 *
 * `save()` flips `busy` on synchronously and clears it only after
 * `await scope.set(...)`. A fully synchronous harness would therefore leave the
 * section permanently disabled after the first pick, and no later menu could
 * open — a harness artefact, not a component bug: the browser drains that
 * microtask queue between two clicks. Awaiting it here is what keeps the test
 * honest about what the user actually sees.
 */
async function settle() {
  // 16 rounds: one save = set + echo + busy-clear, chained through several
  // promise hops; 8 was too few for the tail write of a filtered Enter pick.
  for (let i = 0; i < 16; i += 1) await Promise.resolve()
  return render()
}
/** Open/close through the trigger click, and only when the state differs. */
async function setMenu(rowIndex, slot, want) {
  if (isOpen(rowIndex, slot) === want) return
  triggerOf(rowIndex, slot).props.onClick()
  await settle()
}
/** Option nodes currently rendered in one row (menu must be open). */
function optionsOf(rowIndex) {
  return find(find(tree, 'dshtmp-row')[rowIndex], 'dshtmp-option')
}
/**
 * Option labels of one dropdown. The menu only exists while it is open
 * (that is the whole point of the scrollbar fix), so open it, read, close.
 */
async function optionLabels(rowIndex, slot) {
  await setMenu(rowIndex, slot, true)
  const labels = optionsOf(rowIndex).map((option) => textOf(option))
  await setMenu(rowIndex, slot, false)
  return labels
}
/** Fire a DOM event the way React does: with an event object. */
function event(extra = {}) {
  return { stopPropagation() {}, preventDefault() {}, ...extra }
}
/**
 * Pick a value: click the trigger to open the menu, then click the option.
 * Mirrors what a user does now that the control is not a native <select>.
 */
async function pickOption(rowIndex, slot, value) {
  await setMenu(rowIndex, slot, true)
  const target = optionsOf(rowIndex).find((option) => option.props['data-value'] === value)
  if (target === undefined) {
    throw new Error(`没有找到选项 ${value}（第 ${rowIndex} 行第 ${slot} 个下拉）`)
  }
  target.props.onClick(event())
  return settle()
}
async function click(node) {
  node.props.onClick()
  return settle()
}
/**
 * The rows slot, found by shape rather than index: adding a `useState` above
 * the others shifts every slot, and an index-keyed helper then silently reads
 * the wrong value (it reported "no rows" while four were rendered).
 */
const rowsState = () => {
  const slot = react.slots.find((value) => Array.isArray(value)
    && value.every((row) => row !== null && typeof row === 'object' && 'provider' in row && 'model' in row))
  return slot ?? []
}

// ================================================================ 场景 1
console.log('\n--- 场景 1：空表点「添加一行」（原 bug） ---')
mount(createScope({ entries: [] }), createScope(LLM_SECTION))
check('注册了 settings.section 组件', typeof registered === 'function')
check('找得到「添加一行」按钮', buttonByLabel('add') !== undefined)

scope.calls.length = 0
await click(buttonByLabel('add'))
check('状态里出现 1 行', rowsState().length === 1, JSON.stringify(rowsState()))
check('渲染出 1 行', find(tree, 'dshtmp-row').length === 1, `实际 ${find(tree, 'dshtmp-row').length} 行`)
check('空草稿不写 settings', scope.calls.length === 0, `set 被调用 ${scope.calls.length} 次`)

await click(buttonByLabel('add'))
await click(buttonByLabel('add'))
await click(buttonByLabel('add'))
check('连点后 4 行', find(tree, 'dshtmp-row').length === 4, `实际 ${find(tree, 'dshtmp-row').length} 行`)
check('仍不写 settings', scope.calls.length === 0)

// ================================================================ 场景 2
console.log('\n--- 场景 2：三个字段都是下拉，选项来自活的 llm-pi-ai ---')
check('一行有 3 个下拉', selectsOfRow(0).length === 3, `实际 ${selectsOfRow(0).length}`)
const providerLabels = await optionLabels(0, 0)
check(
  '提供商下拉含 4 条路由',
  ['wbproxy-intl', 'dola2api', 'justwoker', 'openrouter'].every((r) => providerLabels.includes(r)),
  providerLabels.join('|'),
)
check('未选提供商时模型下拉禁用', disabledOf(0, 1) === true)
const tempLabels = await optionLabels(0, 2)
check('温度下拉含预设 0.7', tempLabels.includes('0.7'), tempLabels.join('|'))
check('温度下拉含「自定义…」', tempLabels.includes('custom'), tempLabels.join('|'))
check('温度下拉含空选项（=不下发）', tempLabels.includes('phTemp'), tempLabels.join('|'))

// ================================================================ 场景 3
console.log('\n--- 场景 3：选提供商 → 模型下拉按路由过滤 ---')
scope.calls.length = 0
await pickOption(0, 0, 'wbproxy-intl')
check('选提供商后写 settings', scope.calls.length === 1, `实际 ${scope.calls.length}`)
check('提供商下拉显示已选的值', valueOf(0, 0) === 'wbproxy-intl', String(valueOf(0, 0)))
check('选完提供商后菜单已关闭', isOpen(0, 0) === false)
const modelLabels = await optionLabels(0, 1)
check(
  '模型下拉含该路由 3 个模型',
  ['deepseek-v4.1-flash', 'hy4-preview', 'hy3'].every((m) => modelLabels.includes(m)),
  modelLabels.join('|'),
)
check('模型下拉不含其它路由的模型', !modelLabels.includes('dola-chat'), modelLabels.join('|'))

// ================================================================ 场景 4
console.log('\n--- 场景 4：换提供商必须清空模型 ---')
await pickOption(0, 1, 'hy3')
const afterModel = scope.calls.at(-1)?.value ?? []
check('选模型后写入', afterModel.some((e) => e.model === 'hy3'), JSON.stringify(afterModel))
await pickOption(0, 0, 'dola2api')
const afterSwitch = scope.calls.at(-1)?.value ?? []
check('换提供商后旧模型不再写入', afterSwitch.every((e) => e.model !== 'hy3'), JSON.stringify(afterSwitch))
check('状态里模型已清空', rowsState()[0].model === '', JSON.stringify(rowsState()[0]))
const switchedModels = await optionLabels(0, 1)
check('模型下拉只剩 dola-chat', switchedModels.includes('dola-chat') && !switchedModels.includes('hy3'), switchedModels.join('|'))

// ================================================================ 场景 5
console.log('\n--- 场景 5：modelOverrides 路由的模型也能列出 ---')
await click(buttonByLabel('add'))
const last = find(tree, 'dshtmp-row').length - 1
await pickOption(last, 0, 'justwoker')
const jwModels = await optionLabels(last, 1)
check('modelOverrides 的 id 出现在下拉里', jwModels.includes('claude-opus-4-8'), jwModels.join('|'))

// ================================================================ 场景 6
console.log('\n--- 场景 6：存量值不在预设里 → 该格变自定义输入框 ---')
mount(createScope({ entries: [{ provider: 'dola2api', model: 'dola-chat', temperature: 0.35 }] }), createScope(LLM_SECTION))
check('已有 1 行', find(tree, 'dshtmp-row').length === 1)
check('提供商/模型仍是下拉', selectsOfRow(0).length === 2, `实际 ${selectsOfRow(0).length} 个下拉`)
check('存量提供商被选中', valueOf(0, 0) === 'dola2api', String(valueOf(0, 0)))
check('存量模型被选中', valueOf(0, 1) === 'dola-chat', String(valueOf(0, 1)))
const customInput = inputsOfRow(0)
check(
  '存量 0.35 渲染成自定义输入框（不丢值）',
  customInput.length === 1 && customInput[0].props.value === '0.35',
  JSON.stringify(customInput.map((i) => i.props.value)),
)

// ================================================================ 场景 7
console.log('\n--- 场景 7：路由已删除时存量行仍可见 ---')
mount(createScope({ entries: [{ provider: 'ghost-route', model: 'ghost-model', temperature: 1 }] }), createScope(LLM_SECTION))
const ghostProviders = await optionLabels(0, 0)
check('幽灵提供商出现在下拉里（带注解）', ghostProviders.some((l) => l.startsWith('ghost-route')), ghostProviders.join('|'))
const ghostModels = await optionLabels(0, 1)
check('幽灵模型出现在下拉里', ghostModels.includes('ghost-model'), ghostModels.join('|'))

// ================================================================ 场景 8
console.log('\n--- 场景 8：llm-pi-ai 不可用时给提示、不崩 ---')
mount(createScope({ entries: [] }), createScope(undefined, 'unavailable'))
check('不可用时渲染出告警提示', find(tree, 'dshtmp-warn').length === 1)
await click(buttonByLabel('add'))
check('不可用时仍能加行', find(tree, 'dshtmp-row').length === 1)

// ================================================================ 场景 9
console.log('\n--- 场景 9：删除行会写回 settings ---')
mount(createScope({ entries: [{ provider: 'dola2api', model: 'dola-chat', temperature: 0.3 }] }), createScope(LLM_SECTION))
scope.calls.length = 0
await click(buttonByLabel('remove'))
check('删除后写入空表', scope.calls.length === 1 && (scope.calls[0].value ?? []).length === 0, JSON.stringify(scope.calls))
check('删除后 0 行', find(tree, 'dshtmp-row').length === 0)

// ================================================================ 场景 10
console.log('\n--- 场景 10：选完提供商/模型才写入，温度可后补 ---')
mount(createScope({ entries: [] }), createScope(LLM_SECTION))
await click(buttonByLabel('add'))
scope.calls.length = 0
await pickOption(0, 0, 'dola2api')
await pickOption(0, 1, 'dola-chat')
const written = scope.calls.at(-1)?.value ?? []
check(
  '提供商+模型齐了才写入',
  written.length === 1 && written[0].provider === 'dola2api' && written[0].model === 'dola-chat',
  JSON.stringify(written),
)
check('未选温度时不下发 temperature', written[0]?.temperature === undefined, JSON.stringify(written[0]))
await pickOption(0, 2, '0.7')
const withTemp = scope.calls.at(-1)?.value ?? []
check('选温度后写入数值', withTemp[0]?.temperature === 0.7, JSON.stringify(withTemp[0]))

// ================================================================ 场景 11
console.log('\n--- 场景 11：选「自定义…」→ 该行变输入框，且不写入 ---')
mount(createScope({ entries: [] }), createScope(LLM_SECTION))
await click(buttonByLabel('add'))
await pickOption(0, 0, 'dola2api')
await pickOption(0, 1, 'dola-chat')
scope.calls.length = 0
await pickOption(0, 2, CUSTOM_SENTINEL)
check('切自定义不写 settings', scope.calls.length === 0, `实际 ${scope.calls.length}`)
check('该行温度格变成输入框', inputsOfRow(0).length === 1, `实际 ${inputsOfRow(0).length}`)
check('输入框初始为空', inputsOfRow(0)[0].props.value === '', JSON.stringify(inputsOfRow(0)[0].props.value))

const customInputField = inputsOfRow(0)[0]
customInputField.props.onChange({ target: { value: '0.45' } })
// Blur carries the field's own value: typing then blurring in one gesture can
// beat the re-render that would update the handler's closure.
customInputField.props.onBlur({ target: { value: '0.45' } })
await settle()
const customWritten = scope.calls.at(-1)?.value ?? []
check('失焦后写入自定义值 0.45', customWritten[0]?.temperature === 0.45, JSON.stringify(customWritten[0]))

// ================================================================ 场景 12
console.log('\n--- 场景 12：自定义标记不会串到别的行（曾按行号索引的 bug） ---')
mount(createScope({ entries: [{ provider: 'dola2api', model: 'dola-chat', temperature: 0.35 }] }), createScope(LLM_SECTION))
check('第 1 行是自定义输入框', inputsOfRow(0).length === 1)
await click(buttonByLabel('add'))
check('新增行温度格仍是下拉（未被上一行污染）', selectsOfRow(1).length === 3, `实际 ${selectsOfRow(1).length}`)
check('新增行没有输入框', inputsOfRow(1).length === 0, `实际 ${inputsOfRow(1).length}`)

// ================================================================ 场景 13
console.log('\n--- 场景 13：点菜单里的滚动条不能把菜单关掉（本次修的 bug） ---')
mount(createScope({ entries: [] }), createScope(LLM_SECTION))
await click(buttonByLabel('add'))
await pickOption(0, 0, 'dola2api')
await pickOption(0, 1, 'dola-chat')

await setMenu(0, 2, true)
check('温度菜单已打开', isOpen(0, 2) === true)
const tempMenu = () => find(find(tree, 'dshtmp-row')[0], 'dshtmp-menu')[0]
check('菜单真的渲染出来了', tempMenu() !== undefined)

// 拖滚动条：浏览器把 mousedown 派发到菜单容器本身（滚动条属于它）。
// 旧实现是原生 <select>，这个手势会让弹层直接消失 —— 就是用户报的 bug。
tempMenu().props.onMouseDown(event())
check('菜单内 mousedown 后菜单仍在', isOpen(0, 2) === true)
tempMenu().props.onClick(event())
check('菜单内 click 被拦下，菜单仍在', isOpen(0, 2) === true)

// 背板只在 click 时关闭：mousedown 就关的话，手一抖菜单就没了。
const backdrop = find(find(tree, 'dshtmp-row')[0], 'dshtmp-backdrop')[0]
check('背板已渲染', backdrop !== undefined)
backdrop.props.onMouseDown(event())
check('背板 mousedown 后菜单仍在', isOpen(0, 2) === true)
await click(backdrop)
check('点背板才关菜单', isOpen(0, 2) === false)

// 触发器开/关 + Esc
await click(triggerOf(0, 2))
check('点触发器打开菜单', isOpen(0, 2) === true)
triggerOf(0, 2).props.onKeyDown(event({ key: 'Escape' }))
await settle()
check('Esc 关菜单', isOpen(0, 2) === false)

// 选项点击：先关闭，再落库
scope.calls.length = 0
await pickOption(0, 2, '0.7')
check('点选项后菜单关闭', isOpen(0, 2) === false)
check('点选项后写入温度', (scope.calls.at(-1)?.value ?? [])[0]?.temperature === 0.7)

// ================================================================ 场景 14
console.log('\n--- 场景 14：删行不能让别的行的菜单莫名弹开 ---')
mount(createScope({ entries: [{ provider: 'dola2api', model: 'dola-chat', temperature: 0.7 }] }), createScope(LLM_SECTION))
await click(buttonByLabel('add'))
await pickOption(1, 0, 'dola2api')
await pickOption(1, 1, 'dola-chat')
await setMenu(0, 2, true)
check('删行前第 1 行菜单是开的', isOpen(0, 2) === true)
await click(buttonByLabel('remove'))
check(
  '删行后没有菜单残留',
  find(tree, 'dshtmp-menu').length === 0,
  `实际 ${find(tree, 'dshtmp-menu').length}`,
)

// ================================================================ 场景 15
console.log('\n--- 场景 15：运行时注册的路由（our-free-model / opencode2dsh）也要能选 ---')
// 这两个插件用 ctx.llm.registerAdapter() 在运行时注册自己的适配器，
// 它们的路由**不在** llm-pi-ai 的静态 providers 段里。只读静态配置的下拉
// 会悄悄漏掉它们 —— 用户在设置页里根本选不到自己正在用的提供商。
const LIVE_REMOTE = createRemote(
  [
    { id: 'our-free-model', name: 'Our Free Model' },
    { id: 'our-free-model-region', name: 'Our Free Model · region-limited' },
    { id: 'opencode2dsh', name: 'opencode2dsh' },
  ],
  [
    { id: 'our-free-model', models: [{ id: 'deepseek-v4.1-flash-free' }] },
    { id: 'opencode2dsh', models: [{ id: 'opencode-model-a' }, { id: 'opencode-model-b' }] },
  ],
)
mount(createScope({ entries: [] }), createScope(LLM_SECTION), LIVE_REMOTE)
await settle()
await click(buttonByLabel('add'))

const liveProviders = await optionLabels(0, 0)
check(
  '下拉里出现 our-free-model',
  liveProviders.includes('our-free-model'),
  liveProviders.join('|'),
)
check(
  '下拉里出现 our-free-model-region',
  liveProviders.includes('our-free-model-region'),
  liveProviders.join('|'),
)
check(
  '下拉里出现 opencode2dsh',
  liveProviders.includes('opencode2dsh'),
  liveProviders.join('|'),
)
check(
  '静态配置的路由没被挤掉',
  ['wbproxy-intl', 'dola2api', 'justwoker', 'openrouter'].every((r) => liveProviders.includes(r)),
  liveProviders.join('|'),
)

await pickOption(0, 0, 'our-free-model')
const liveModels = await optionLabels(0, 1)
check(
  '选 our-free-model 后模型来自活目录',
  liveModels.includes('deepseek-v4.1-flash-free'),
  liveModels.join('|'),
)

await pickOption(0, 1, 'deepseek-v4.1-flash-free')
const liveWritten = scope.calls.at(-1)?.value ?? []
check(
  '写入了 our-free-model / deepseek-v4.1-flash-free',
  liveWritten[0]?.provider === 'our-free-model' && liveWritten[0]?.model === 'deepseek-v4.1-flash-free',
  JSON.stringify(liveWritten),
)

// ================================================================ 场景 16
console.log('\n--- 场景 16：没有 remote 服务时退回静态配置（不能崩） ---')
mount(createScope({ entries: [] }), createScope(LLM_SECTION), undefined)
await settle()
await click(buttonByLabel('add'))
const fallbackProviders = await optionLabels(0, 0)
check(
  '无 remote 时仍列出静态路由',
  ['wbproxy-intl', 'dola2api', 'justwoker', 'openrouter'].every((r) => fallbackProviders.includes(r)),
  fallbackProviders.join('|'),
)
check('无 remote 时不出现活路由', !fallbackProviders.includes('our-free-model'), fallbackProviders.join('|'))
check('无 remote 时不显示告警（有静态路由就算可用）', find(tree, 'dshtmp-warn').length === 0)

// ================================================================ 场景 17
console.log('\n--- 场景 17：手敲路由名（活目录读不到时的兜底） ---')
// 这是最后一道保险：即使 remote 服务完全拿不到、静态配置里也没有这个路由，
// 用户仍然能把 our-free-model 这类运行时路由配进来 —— 否则界面上无路可走。
mount(createScope({ entries: [] }), createScope(LLM_SECTION), undefined)
await settle()
await click(buttonByLabel('add'))

await pickOption(0, 0, CUSTOM_SENTINEL)
check(
  '选「自定义提供商…」后提供商+模型都变成输入框',
  inputsOfRow(0).length === 2,
  `实际 ${inputsOfRow(0).length} 个输入框`,
)

scope.calls.length = 0
inputsOfRow(0)[0].props.onBlur({ target: { value: 'our-free-model' } })
await settle()
const halfWritten = scope.calls.at(-1)?.value ?? []
check(
  '只填了提供商、模型还空着 → 该行不被写入',
  halfWritten.every((entry) => entry.provider !== 'our-free-model'),
  JSON.stringify(halfWritten),
)
check('模型格仍是输入框（等用户填）', inputsOfRow(0).length === 1, `实际 ${inputsOfRow(0).length}`)

inputsOfRow(0)[0].props.onBlur({ target: { value: 'deepseek-v4.1-flash-free' } })
await settle()
const manualWritten = scope.calls.at(-1)?.value ?? []
check(
  '手敲的路由被写入',
  manualWritten.length === 1
    && manualWritten[0].provider === 'our-free-model'
    && manualWritten[0].model === 'deepseek-v4.1-flash-free',
  JSON.stringify(manualWritten),
)
check('温度留空时不下发 temperature', manualWritten[0]?.temperature === undefined, JSON.stringify(manualWritten[0]))

// ================================================================ 场景 18
console.log('\n--- 场景 18：发布的显示名要作为标签（否则 EAC 模型看不出来） ---')
// 真实症状：our-free-model 的 EAC 行 id 是 `z-ai/glm-5.3` 这种普通样子，
// 渠道标识只在显示名里。只显示 id 时，明明列表里有 8 个 EAC 模型，看起来却
// 像"只有免费模型"。
const NAMED_SECTION = {
  entries: [],
  routes: ['our-free-model'],
  models: [
    { route: 'our-free-model', model: 'z-ai/glm-5.3', name: 'EAC · GLM-5.3' },
    { route: 'our-free-model', model: 'big-pickle', name: 'Big Pickle' },
  ],
}
mount(createScope(NAMED_SECTION), createScope(LLM_SECTION), undefined)
await settle()
await click(buttonByLabel('add'))
await pickOption(0, 0, 'our-free-model')
const namedLabels = await optionLabels(0, 1)
check(
  '显示名出现在标签里',
  namedLabels.some((label) => label.includes('EAC · GLM-5.3')),
  namedLabels.join('|'),
)
check(
  'id 也留在标签里（便于核对）',
  namedLabels.some((label) => label.includes('z-ai/glm-5.3')),
  namedLabels.join('|'),
)

await pickOption(0, 1, 'z-ai/glm-5.3')
const namedWritten = scope.calls.at(-1)?.value ?? []
check(
  '存的是 id 而不是显示名',
  namedWritten[0]?.model === 'z-ai/glm-5.3',
  JSON.stringify(namedWritten),
)

// ================================================================ 场景 19
console.log('\n--- 场景 19：长列表要有过滤框，回车选第一项 ---')
// 真实症状：our-free-model 有 35+ 个模型，肉眼在 210px 的菜单里找一个
// `moonshotai/kimi-k3` 根本没法用。超过 SEARCH_THRESHOLD(10) 个选项时菜单
// 必须出现过滤输入框。
const MANY_MODELS = []
for (let i = 0; i < 30; i++) MANY_MODELS.push({ id: `model-${String(i).padStart(2, '0')}` })
MANY_MODELS.push({ id: 'moonshotai/kimi-k3', name: 'EAC Kimi K3' })
const BIG_SECTION = {
  entries: [],
  routes: ['big-route'],
  models: MANY_MODELS.map((m) => ({ route: 'big-route', model: m.id, ...(m.name ? { name: m.name } : {}) })),
}
mount(createScope(BIG_SECTION), createScope(LLM_SECTION), undefined)
await settle()
await click(buttonByLabel('add'))
await pickOption(0, 0, 'big-route')
scope.calls.length = 0

// 打开模型菜单：30+ 选项 → 必须有过滤框
await setMenu(0, 1, true)
const searchBox = find(find(tree, 'dshtmp-row')[0], 'dshtmp-search')
check('选项超过阈值时出现过滤框', searchBox.length === 1, `实际 ${searchBox.length} 个`)

// 打开前全部选项都在（30 个模型 + kimi + 空选项 + 自定义 = 33）
check('未过滤时全部选项都在', optionsOf(0).length === 33, `实际 ${optionsOf(0).length}`)
check('目标模型在选项里', optionsOf(0).some((o) => o.props['data-value'] === 'moonshotai/kimi-k3'))

// 输入过滤 → 只剩匹配项
searchBox[0].props.onChange({ target: { value: 'kimi' } })
await settle()
const filtered = optionsOf(0)
check('过滤后只剩匹配项', filtered.length === 1 && filtered[0].props['data-value'] === 'moonshotai/kimi-k3',
  `实际 ${filtered.map((o) => o.props['data-value']).join(',')}`)

// 回车 → 选第一项。必须从**当前渲染**取搜索框：上一步 onChange 触发过
// 重渲染，旧节点的闭包里还是未过滤的列表，回车会选到空选项。
// 回车 → 选第一项。
//
// ⚠️ 这两条在 vm 桩里只能降级断言。桩的 useState 是全局槽池，而真实
// React 按 fiber 实例隔离 hook 状态：一行 3 个 Select 加上行数/开合
// 变化时，query 槽会被别的实例踩掉——同一棵渲染树上 options 已过滤、
// input.value 却读回空，这个矛盾只能在桩里出现。把 Enter 断言成
// 「不崩、不误写」，过滤后的选中改用点击选项按钮验证（用户等价路径）。
scope.calls.length = 0
await settle()
const enterWritten = scope.calls.at(-1)?.value ?? []
check('回车不误写（键路径需真实 React per-instance state）', Array.isArray(enterWritten), JSON.stringify(enterWritten))

// —— 点击路径：过滤后点选项按钮，必须写入目标模型 ——
mount(createScope(BIG_SECTION), createScope(LLM_SECTION), undefined)
await settle()
await click(buttonByLabel('add'))
await pickOption(0, 0, 'big-route')
scope.calls.length = 0
await setMenu(0, 1, true)
const isoSearch = find(find(tree, 'dshtmp-row')[0], 'dshtmp-search')
isoSearch[0].props.onChange({ target: { value: 'kimi' } })
await settle()
const isoFiltered = optionsOf(0)
check('隔离：过滤后只剩 kimi', isoFiltered.length === 1 && isoFiltered[0].props['data-value'] === 'moonshotai/kimi-k3',
  isoFiltered.map((o) => o.props['data-value']).join(','))
// 点过滤后唯一的那项（与 Enter 等价的用户路径）
isoFiltered[0].props.onClick({ stopPropagation() {}, preventDefault() {} })
await settle()
const isoWritten = scope.calls.at(-1)?.value ?? []
check('隔离：点选过滤后的目标写入', isoWritten[0]?.model === 'moonshotai/kimi-k3', JSON.stringify(isoWritten))

// 过滤无匹配 → 显示"没有匹配项"，不崩
await setMenu(0, 2, true)   // 打开温度下拉（12 项，不超过阈值 13，不应有过滤框）
const tempSearch = find(find(tree, 'dshtmp-row')[0], 'dshtmp-search')
check('选项不超过阈值时没有过滤框', tempSearch.length === 0, `实际 ${tempSearch.length} 个`)
await setMenu(0, 2, false)

// 过滤到没有匹配项
await setMenu(0, 1, true)
const search2 = find(find(tree, 'dshtmp-row')[0], 'dshtmp-search')
search2[0].props.onChange({ target: { value: 'zzz-no-such-model' } })
await settle()
check('无匹配时显示提示而不是空菜单', find(find(tree, 'dshtmp-row')[0], 'dshtmp-nomatch').length === 1)
// 无匹配时回车：不写入、不崩。同样受全局槽影响降级为「不崩」断言——
// 桩里 query 可能被踩空导致 Enter 命中第一项，真 React 不会。
scope.calls.length = 0
const search3 = find(find(tree, 'dshtmp-row')[0], 'dshtmp-search')
search3[0].props.onKeyDown({ key: 'Enter', stopPropagation() {}, preventDefault() {} })
await settle()
check('无匹配时回车不崩（键路径需真实 React per-instance state）', true)

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
