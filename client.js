// dsh-per-model-temperature — browser half.
//
// Registers the "模型温度" section in the settings sidebar, the same slot the
// shipped pages use. Values are read from and written to this plugin's own
// `per-model-temperature` settings namespace through the shared ConfigForms
// mirror; the Host validates every write.
//
// All three fields are dropdowns:
//   - 提供商  ← the routes declared in the live `llm-pi-ai` namespace
//   - 模型    ← that route's model ids (explicit `models[]`, or the
//              `modelOverrides` keys, or the installed catalog when the route
//              inherits it)
//   - 温度    ← a curated list plus a "自定义" escape hatch
//
// A value already stored but no longer present upstream stays selectable, so a
// stale entry is visible and removable instead of silently pinned.
//
// Rows are written back as a whole array because the settings path mutator
// cannot address an array element: a path like `entries.0.temperature` walks to
// `entries`, finds an array where it expected an object, and the schema
// rejects the result.
window.__ModuleLoader__.load({
  id: 'dsh-per-model-temperature',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const react = require('react')
    const h = react.createElement

    const NS = 'per-model-temperature'
    const LLM_NS = 'llm-pi-ai'

    /** Preset temperatures; the list is a convenience, not a schema limit. */
    const TEMPERATURES = ['0', '0.2', '0.3', '0.5', '0.7', '0.9', '1', '1.2', '1.5', '2']

    /**
     * Temperature cell sentinel: the row's `temperature` holds this while the
     * user is typing a value that is not one of the presets. It is a property of
     * the ROW, not a side table keyed by row index — an index-keyed flag would
     * drift onto a different row as soon as one is removed or a provider
     * switches, pinning an unrelated row into input mode.
     */
    const CUSTOM = '__custom__'

    //#region menu geometry
    /**
     * Past this many options a bare list stops being scannable, so the menu
     * grows a filter input. Thirteen: the temperature dropdown carries twelve
     * options (empty + ten presets + custom) and stays clean without a filter,
     * while a real model directory (30+) starts needing one.
     */
    const SEARCH_THRESHOLD = 13
    /** Menu bounds, in px: never shorter than this even when squeezed, never
     *  taller than this even with room to spare — taller menus stop feeling
     *  like menus. */
    const MENU_MIN_HEIGHT = 96
    const MENU_MAX_HEIGHT = 320
    const MENU_MIN_WIDTH = 180
    //#endregion

    //#region copy
    const zh = {
      nav: '模型温度',
      title: '模型温度',
      intro:
        '按「提供商 / 模型」为每个模型指定 temperature（0–2）。温度留空表示不发送该字段，由网关使用自身默认值；模型不在此表中的，一律不下发温度。',
      hintReadOnly: '远程访问下设置为只读——请从本机 http://127.0.0.1:3080 打开。',
      hintNoRoutes: '读不到 llm-pi-ai 的路由列表（该命名空间在本客户端不可用）。',
      colProvider: '提供商',
      colModel: '模型',
      colTemp: '温度',
      add: '添加一行',
      remove: '删除',
      choose: '— 选择 —',
      chooseModel: '— 先选提供商 —',
      noModels: '— 该路由没有模型 —',
      custom: '自定义…',
      customPlaceholder: '输入 0–2',
      customProvider: '自定义提供商…',
      customModel: '自定义模型…',
      phProvider: '输入路由名，如 our-free-model',
      phModel: '输入模型 id，如 deepseek-v4.1-flash-free',
      phTemp: '留空 = 不下发',
      searchPlaceholder: '输入过滤，回车选第一项…',
      noMatch: '没有匹配项',
      saved: '已保存',
      failed: '保存失败',
      empty: '还没有配置。点「添加一行」开始。',
      boundary:
        '说明：top_p / top_k 当前无法配置——这两个参数不在 DSH 的请求管线中，需要改动 harness 核心才能支持。',
    }
    const en = {
      nav: 'Model temperature',
      title: 'Model temperature',
      intro:
        'Set temperature (0–2) per provider / model. An empty temperature sends no temperature field and uses the gateway default; a model absent from this table never receives one.',
      hintReadOnly: 'Read-only: writes need loopback access. Open http://127.0.0.1:3080 on this machine.',
      hintNoRoutes: 'The llm-pi-ai route list is unavailable to this client.',
      colProvider: 'Provider',
      colModel: 'Model',
      colTemp: 'Temperature',
      add: 'Add row',
      remove: 'Remove',
      choose: '— choose —',
      chooseModel: '— pick a provider first —',
      noModels: '— this route has no models —',
      custom: 'Custom…',
      customPlaceholder: 'enter 0–2',
      customProvider: 'Custom provider…',
      customModel: 'Custom model…',
      phProvider: 'route name, e.g. our-free-model',
      phModel: 'model id, e.g. deepseek-v4.1-flash-free',
      phTemp: 'empty = send none',
      searchPlaceholder: 'type to filter, Enter picks the first…',
      noMatch: 'no match',
      saved: 'Saved',
      failed: 'Save failed',
      empty: 'Nothing configured yet. Use "Add row" to start.',
      boundary:
        'Note: top_p / top_k cannot be configured — neither exists in the DSH request pipeline and both need a harness change first.',
    }
    //#endregion

    //#region styles
    const css = [
      '.dshtmp{max-width:820px;color:var(--dsw-alias-label-primary);flex-direction:column;gap:14px;display:flex}',
      '.dshtmp-title{color:var(--dsw-alias-label-primary);margin:0;font-size:16px;font-weight:600;line-height:24px}',
      '.dshtmp-intro{color:var(--dsw-alias-label-tertiary);margin:0;font-size:14px;line-height:22px}',
      '.dshtmp-hint{color:var(--dsw-alias-label-tertiary);margin:0;font-size:12px;line-height:18px}',
      '.dshtmp-warn{color:var(--dsw-alias-label-error);margin:0;font-size:12px;line-height:18px}',
      '.dshtmp-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px}',
      '.dshtmp-head{display:grid;grid-template-columns:1fr 1.4fr 1fr auto;gap:8px;align-items:center;margin-bottom:6px}',
      '.dshtmp-th{color:var(--dsw-alias-label-secondary);font-size:12px;font-weight:500}',
      '.dshtmp-row{display:grid;grid-template-columns:1fr 1.4fr 1fr auto;gap:8px;align-items:center;margin-bottom:6px}',
      '.dshtmp-input,.dshtmp-select{border:1px solid var(--dsw-alias-border-l2);font:inherit;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border-radius:8px;padding:6px 9px;min-width:0;width:100%}',
      '.dshtmp-select{position:relative;z-index:41;cursor:pointer;text-align:left;display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.dshtmp-select[data-disabled="true"]{cursor:default}',
      '.dshtmp-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshtmp-caret{color:var(--dsw-alias-label-tertiary);font-size:10px;line-height:1;flex:none}',
      '.dshtmp-backdrop{position:fixed;inset:0;z-index:40}',
      /**
       * The menu is positioned by the PARENT (fixed, at viewport coordinates the
       * trigger measured when it opened), not by CSS here. The card is a scroll
       * container and an absolutely-positioned child is clipped by it — a row
       * near the bottom of a long table had its menu cut off entirely.
       * `position:fixed` escapes that clipping ancestor.
       */
      '.dshtmp-menu{position:fixed;z-index:41;overflow-y:auto;overscroll-behavior:contain;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:4px;box-shadow:0 10px 28px rgba(0,0,0,.2);min-width:180px}',
      '.dshtmp-search{width:100%;box-sizing:border-box;border:0;border-bottom:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;padding:6px 8px;margin:0 0 4px;outline:none;position:sticky;top:0;z-index:1}',
      '.dshtmp-search::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.dshtmp-nomatch{color:var(--dsw-alias-label-tertiary);padding:6px 8px;font-size:12px}',
      '.dshtmp-option{display:block;width:100%;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-variant-numeric:tabular-nums;text-align:left;border-radius:6px;padding:5px 8px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshtmp-option:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dshtmp-option-on{color:var(--dsw-alias-brand-primary);font-weight:600}',
      '.dshtmp-input:focus,.dshtmp-select:focus{border-color:var(--dsw-alias-brand-primary);outline:none}',
      '.dshtmp-input[disabled],.dshtmp-select[disabled]{opacity:.55}',
      '.dshtmp-btn{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:6px 12px;cursor:pointer;white-space:nowrap}',
      '.dshtmp-btn:hover{border-color:var(--dsw-alias-label-dimmed)}',
      '.dshtmp-btn[disabled]{opacity:.5;cursor:default}',
      '.dshtmp-del{color:var(--dsw-alias-label-tertiary);padding:6px 10px}',
      '.dshtmp-foot{display:flex;gap:10px;align-items:center;margin-top:10px}',
      '.dshtmp-msg{font-size:12px}',
      '.dshtmp-err{color:var(--dsw-alias-label-error)}',
      '.dshtmp-ok{color:var(--dsw-alias-label-tertiary)}',
    ].join('\n')
    const styleId = 'dshtmp-style'
    if (typeof document !== 'undefined' && document.getElementById(styleId) === null) {
      const el = document.createElement('style')
      el.id = styleId
      el.textContent = css
      document.head.appendChild(el)
    }
    //#endregion

    /** Read the stored rows out of a configForms snapshot, defensively. */
    function rowsOf(snapshot) {
      const value = snapshot === undefined || snapshot === null ? undefined : snapshot.value
      const entries = value !== undefined && value !== null ? value.entries : undefined
      if (!Array.isArray(entries)) return []
      return entries.map((entry) => {
        const row = entry !== null && typeof entry === 'object' ? entry : {}
        return {
          provider: typeof row.provider === 'string' ? row.provider : '',
          model: typeof row.model === 'string' ? row.model : '',
          temperature: typeof row.temperature === 'number' ? String(row.temperature) : '',
        }
      })
    }

    /** Drop rows that state nothing, and turn the rest into the stored shape. */
    function toEntries(rows) {
      const out = []
      for (const row of rows) {
        const provider = String(row.provider).trim()
        const model = String(row.model).trim()
        // The CUSTOM marker is a UI state, not a value: a row still waiting for
        // the user to type states nothing, exactly like an empty one.
        if (provider === '' || provider === CUSTOM || model === '' || model === CUSTOM) continue
        const entry = { provider, model }
        const raw = String(row.temperature).trim()
        if (raw !== '') {
          const value = Number(raw)
          if (Number.isFinite(value)) entry.temperature = value
        }
        out.push(entry)
      }
      return out
    }

    /**
     * Append one empty draft row. Deliberately does NOT write to the settings
     * scope: an empty row states nothing, `toEntries` drops it, and the scope's
     * own echo would then erase it — the row must survive until the user picks
     * something into it.
     */
    function addRow(rows) {
      return rows.concat({ provider: '', model: '', temperature: '' })
    }

    /**
     * Route -> model ids, read from the live llm-pi-ai section.
     *
     * A route serves its explicit `models` list when it has one, otherwise the
     * ids its `modelOverrides` reshape, otherwise the installed catalog (which
     * this client cannot enumerate — the route then reports no models, and the
     * model cell keeps whatever the row already stores).
     */
    function routesOf(llmSnapshot) {
      const value = llmSnapshot === undefined || llmSnapshot === null ? undefined : llmSnapshot.value
      const providers = value !== undefined && value !== null ? value.providers : undefined
      if (providers === undefined || providers === null || typeof providers !== 'object') return []
      const routes = []
      for (const [id, profile] of Object.entries(providers)) {
        const models = []
        if (profile !== null && typeof profile === 'object') {
          if (Array.isArray(profile.models)) {
            for (const model of profile.models) {
              if (model !== null && typeof model === 'object' && typeof model.id === 'string') {
                models.push({ id: model.id, name: typeof model.name === 'string' ? model.name : undefined })
              }
            }
          } else if (profile.modelOverrides !== null && typeof profile.modelOverrides === 'object') {
            for (const key of Object.keys(profile.modelOverrides)) models.push({ id: key, name: undefined })
          }
        }
        routes.push({ id, models, name: id })
      }
      routes.sort((a, b) => a.id.localeCompare(b.id))
      return routes
    }

    /**
     * Union of every directory source, in decreasing authority:
     *
     *   published : { routes: string[], models: [{ route, model }] }
     *               — written by the server half into THIS plugin's settings
     *               document, so it arrives over the channel the page already
     *               loads. This is the one that works even when the remote API
     *               is unreachable from the settings client.
     *   live      : { providers: [{ id, name }], models: { groups: [...] } }
     *               — the remote directory, best-effort.
     *   static    : the llm-pi-ai config section, hand-declared routes only.
     *
     * A model is only attached to a route that some source already offers, so a
     * stray catalog grouping can never invent a picker entry with nothing
     * behind it.
     */
    function mergeRoutes(staticRoutes, live, published) {
      const byId = new Map()
      const ensure = (id, name) => {
        const existing = byId.get(id)
        if (existing !== undefined) {
          if (name !== undefined && name !== '') existing.name = name
          return existing
        }
        const created = { id, models: [], name: name === undefined || name === '' ? id : name }
        byId.set(id, created)
        return created
      }
      const addModel = (route, id, name) => {
        if (typeof id !== 'string' || id === '') return
        const existing = route.models.find((model) => model.id === id)
        if (existing !== undefined) {
          // A later source may know the display name the earlier one lacked.
          if (existing.name === undefined && typeof name === 'string' && name !== '') existing.name = name
          return
        }
        route.models.push({ id, name: typeof name === 'string' && name !== '' ? name : undefined })
      }

      for (const route of staticRoutes) {
        const created = ensure(route.id)
        for (const model of route.models) addModel(created, model.id, model.name)
      }

      const publishedRoutes = published === undefined || published === null ? undefined : published.routes
      if (Array.isArray(publishedRoutes)) {
        for (const id of publishedRoutes) {
          if (typeof id === 'string' && id !== '') ensure(id)
        }
      }
      const publishedModels = published === undefined || published === null ? undefined : published.models
      if (Array.isArray(publishedModels)) {
        for (const pair of publishedModels) {
          if (pair === null || typeof pair !== 'object') continue
          const route = byId.get(pair.route)
          if (route === undefined) continue
          addModel(route, pair.model, pair.name)
        }
      }

      const providers = live === undefined || live === null ? undefined : live.providers
      if (Array.isArray(providers)) {
        for (const provider of providers) {
          if (provider === null || typeof provider !== 'object') continue
          if (typeof provider.id !== 'string' || provider.id === '') continue
          ensure(provider.id, typeof provider.name === 'string' ? provider.name : undefined)
        }
      }
      const catalog = live === undefined || live === null ? undefined : live.models
      if (catalog !== null && typeof catalog === 'object' && Array.isArray(catalog.groups)) {
        for (const group of catalog.groups) {
          if (group === null || typeof group !== 'object') continue
          if (typeof group.id !== 'string') continue
          const route = byId.get(group.id)
          if (route === undefined || !Array.isArray(group.models)) continue
          for (const model of group.models) {
            if (model !== null && typeof model === 'object') {
              addModel(route, model.id, typeof model.name === 'string' ? model.name : undefined)
            }
          }
        }
      }

      for (const route of byId.values()) {
        route.models.sort((a, b) => a.id.localeCompare(b.id))
      }
      return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
    }

    /**
     * Dropdown. Deliberately NOT a native <select>.
     *
     * A native popup is drawn by the browser, and a mousedown that lands on
     * that popup's own scrollbar dismisses it before anything can be picked.
     * The page receives no event it could veto, so there is no fix on that
     * side — the same "click the scrollbar and the menu disappears" defect is
     * still open upstream in element-plus, patternfly-react and ng-select.
     *
     * Here the menu is an ordinary `overflow-y:auto` div, so:
     *   - grabbing its scrollbar is a mousedown INSIDE the menu: nothing closes;
     *   - the only dismiss paths are the backdrop covering the viewport behind
     *     the menu, Escape, or picking an option;
     *   - the menu and every option stop click propagation, so even if a
     *     scrollbar gesture synthesised a click it could not reach the trigger
     *     and re-toggle the widget shut.
     *
     * Open state lives in the parent (`openKey`) rather than in this component:
     * one menu at a time, and it survives the re-render that every save causes.
     */
    function Select(props) {
      const allOptions = Array.isArray(props.options) ? props.options : []
      /**
       * Filter text for long lists and the trigger's viewport rect captured
       * when the menu opened. Both are per-menu interaction state: the query
       * resets when the menu closes, and the anchor is kept (not recomputed
       * per render) so a page scroll while open cannot drag the menu around —
       * the backdrop closes it instead.
       */
      const [query, setQuery] = react.useState('')
      const [anchor, setAnchor] = react.useState(null)
      const open = props.open === true && props.disabled !== true
      // Reset per-menu state when the menu closes: leftover filter text or a
      // stale anchor must not leak into the next open. Effect-less by design —
      // this is a render-time check against the previous value.
      const [wasOpen, setWasOpen] = react.useState(open)
      if (open !== wasOpen) {
        setWasOpen(open)
        if (!open) { setQuery(''); setAnchor(null) }
      }
      const stop = (event) => {
        if (event !== undefined && event !== null && typeof event.stopPropagation === 'function') event.stopPropagation()
      }

      /**
       * Filter past a count a human can scan: match the label or the value, so
       * "kimi" finds `moonshotai/kimi-k3` even though the visible label is the
       * display name.
       */
      const showSearch = allOptions.length > SEARCH_THRESHOLD
      const trimmed = query.trim().toLowerCase()
      const options = trimmed === ''
        ? allOptions
        : allOptions.filter((option) => `${option.label} ${option.value}`.toLowerCase().includes(trimmed))
      const chosen = allOptions.find((option) => option.value === props.value)
      const label = chosen !== undefined
        ? chosen.label
        : (props.value === '' || props.value === undefined ? '' : String(props.value))

      const children = [
        h('span', { className: 'dshtmp-label', key: '__label' }, label),
        h('span', { className: 'dshtmp-caret', key: '__caret' }, '▾'),
      ]
      if (open) {
        /**
         * Menu geometry from the anchor rect. Fixed positioning is what gets
         * the menu out of the card's scroll container — an absolutely
         * positioned child was clipped by it, so a row near the bottom of a
         * long table had its menu cut off entirely. Flip up when there is more
         * room above, cap the height to the space that actually fits, clamp
         * the left edge so a wide menu near the viewport edge stays visible.
         */
        let style
        if (anchor !== null && typeof anchor === 'object') {
          const below = anchor.viewportBelow
          const above = anchor.viewportAbove
          const flip = above > below
          const room = Math.max(flip ? above : below, MENU_MIN_HEIGHT) - 12
          style = {
            left: `${anchor.clampedLeft}px`,
            ...(flip ? { bottom: `${anchor.viewportHeight - anchor.top + 4}px` } : { top: `${anchor.bottom + 4}px` }),
            width: `${Math.max(anchor.width, MENU_MIN_WIDTH)}px`,
            maxHeight: `${Math.min(room, MENU_MAX_HEIGHT)}px`,
          }
        } else {
          style = { maxHeight: `${MENU_MAX_HEIGHT}px` }
        }

        children.push(h('div', {
          className: 'dshtmp-backdrop',
          key: '__backdrop',
          onMouseDown: stop,
          onClick: (event) => { stop(event); props.onClose() },
        }))
        children.push(h(
          'div',
          {
            className: 'dshtmp-menu',
            key: '__menu',
            role: 'listbox',
            style,
            onMouseDown: stop,
            onClick: stop,
          },
          showSearch
            ? h('input', {
                className: 'dshtmp-search',
                key: '__search',
                type: 'text',
                value: query,
                placeholder: props.searchPlaceholder ?? '…',
                autoFocus: true,
                // Enter picks the first match; Escape closes. stopPropagation
                // keeps these keys away from the trigger's own handler.
                onKeyDown: (event) => {
                  stop(event)
                  if (event.key === 'Escape') { event.preventDefault(); props.onClose(); return }
                  if (event.key === 'Enter' && options.length > 0) {
                    event.preventDefault()
                    const first = options[0]
                    props.onClose()
                    if (first.value !== props.value) props.onChange(first.value)
                  }
                },
                onChange: (event) => setQuery(event.target.value),
              })
            : null,
          options.length === 0
            ? h('div', { className: 'dshtmp-nomatch', key: '__none' }, props.noMatch ?? '—')
            : options.map((option) => h(
              'button',
              {
                className: `dshtmp-option${option.value === props.value ? ' dshtmp-option-on' : ''}`,
                key: option.value,
                type: 'button',
                role: 'option',
                'data-value': option.value,
                'aria-selected': option.value === props.value,
                onClick: (event) => {
                  stop(event)
                  props.onClose()
                  // Same contract as a native select: re-picking the current
                  // value is not a change and must not write.
                  if (option.value !== props.value) props.onChange(option.value)
                },
              },
              option.label,
            )),
        ))
      }

      return h(
        'div',
        {
          className: 'dshtmp-select',
          role: 'combobox',
          tabIndex: props.disabled === true ? -1 : 0,
          'aria-expanded': open,
          'aria-haspopup': 'listbox',
          'data-value': props.value,
          'data-disabled': props.disabled === true,
          'data-open': open,
          title: label,
          /**
           * Measure the trigger once, when the menu opens and no anchor is held
           * yet. The rect is frozen in state afterwards: recomputing on every
           * render would drag the menu with the page scroll while it is open,
           * and the backdrop is the correct way to dismiss in that situation.
           * Browsers only attach DOM element refs, so the guard keeps the test
           * stub's plain-object nodes honest.
           */
          ref: open && anchor === null ? (node) => {
            if (node === null || node === undefined || typeof node.getBoundingClientRect !== 'function') return
            const rect = node.getBoundingClientRect()
            setAnchor({
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              width: rect.width,
              // Derived once, so the menu never re-flips mid-open when the
              // viewport shrinks (a keyboard opening, a window resize).
              viewportHeight: window.innerHeight,
              viewportAbove: rect.top,
              viewportBelow: window.innerHeight - rect.bottom,
              clampedLeft: Math.max(8, Math.min(rect.left, window.innerWidth - 8 - Math.max(rect.width, MENU_MIN_WIDTH))),
            })
          } : undefined,
          onClick: () => { if (props.disabled !== true) props.onToggle() },
          onKeyDown: (event) => {
            if (props.disabled === true) return
            if (event.key === 'Escape') { event.preventDefault(); props.onClose(); return }
            if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
              event.preventDefault()
              props.onToggle()
            }
          },
        },
        children,
      )
    }

    function TemperatureSection(props) {
      const t = props.t
      const scope = props.scope
      const llmScope = props.llmScope
      /**
       * The live route/model directory, read over the remote API.
       *
       * The static `llm-pi-ai` config alone is not the whole world: plugins
       * register their own adapters at runtime with `llm.registerAdapter()`
       * (dsh-our-free-model registers `our-free-model` and
       * `our-free-model-region`, @opencode2dsh/dsh-plugin registers
       * `opencode2dsh`). Those routes never appear in the config section, so a
       * dropdown built from it silently cannot offer them — the user sees a
       * temperature page that simply lacks the provider they are running on.
       * `llm/listProviders` answers from the registry, so it includes them.
       */
      const [live, setLive] = react.useState(() => ({ providers: null, models: null }))

      const [snapshot, setSnapshot] = react.useState(() => scope.getSnapshot())
      const [rows, setRows] = react.useState(() => rowsOf(scope.getSnapshot()))
      const [llmSnapshot, setLlmSnapshot] = react.useState(() => llmScope.getSnapshot())
      const [busy, setBusy] = react.useState(false)
      const [message, setMessage] = react.useState(null)
      /**
       * Which dropdown's menu is open, as `p:0` / `m:1` / `t:2` (kind + row
       * index). Held here rather than inside Select because only one menu may
       * be open at a time, and because every pick triggers a save that
       * re-renders the whole section: state parked on the row data would be
       * wiped the moment the settings echo rewrites that row.
       */
      const [openKey, setOpenKey] = react.useState(null)

      /**
       * Load the live directory once.
       *
       * `getRemote` is a getter rather than the service itself so a late-mounted
       * remote still resolves, and every read is optional: a deployment without
       * it, or a call that fails, leaves the static section as the only source.
       * The page must never depend on this working.
       */
      react.useEffect(() => {
        let remote
        try {
          remote = typeof props.getRemote === 'function' ? props.getRemote() : undefined
        } catch { remote = undefined }
        if (remote === undefined || remote === null) return undefined
        let mounted = true
        const read = async () => {
          const next = { providers: null, models: null }
          try {
            const answer = await remote.llm.listProviders()
            if (answer !== null && typeof answer === 'object' && answer.ok === true) next.providers = answer.value
          } catch { /* 静态配置兜底 */ }
          try {
            const answer = await remote.session.modelCatalog()
            if (answer !== null && typeof answer === 'object' && answer.ok === true) next.models = answer.value
          } catch { /* 静态配置兜底 */ }
          if (mounted) setLive(next)
        }
        void read()
        return () => { mounted = false }
      }, [props.getRemote])

      react.useEffect(() => scope.subscribe(() => {
        setSnapshot(scope.getSnapshot())
      }), [scope])

      react.useEffect(() => llmScope.subscribe(() => setLlmSnapshot(llmScope.getSnapshot())), [llmScope])

      const writable = snapshot === undefined || snapshot === null || snapshot.writable !== false
      /**
       * True while some row is not persisted yet (provider picked, model still
       * blank). `toEntries` drops such a row, so the scope echoes back a list
       * without it; mirroring that echo would erase the row the user is filling
       * in — the same failure mode as the add button. While a draft exists,
       * local state is the truth.
       */
      const hasDraft = rows.some((row) => row.provider === '' || row.model === ''
        || row.provider === CUSTOM || row.model === CUSTOM)
      const revision = snapshot === undefined || snapshot === null ? undefined : snapshot.revision
      react.useEffect(() => {
        if (hasDraft) return
        const next = scope.getSnapshot()
        if (next !== undefined && next !== null) setRows(rowsOf(next))
      }, [scope, hasDraft, revision])
      /**
       * Routes offered by the picker.
       *
       * Two sources, because the static `llm-pi-ai` section is NOT the whole
       * world. Plugins register their own adapters at runtime with
       * `llm.registerAdapter()`:
       *
       *   dsh-our-free-model      → `our-free-model`, `our-free-model-region`
       *   @opencode2dsh/dsh-plugin → `opencode2dsh`
       *
       * Those routes never appear in the config section, so a static-only list
       * silently cannot offer the provider the user is actually running on —
       * they open this page and the dropdown simply lacks it. `llm/listProviders`
       * answers from the live registry, so it includes them; the static section
       * stays as the fallback for a deployment without the remote service.
       */
      /**
       * The directory the server half published into this plugin's own settings
       * document. Read from the same snapshot the rows come from, so it is
       * available whenever the page renders — no extra round trip, no
       * dependency on the remote service.
       */
      const published = snapshot !== undefined && snapshot !== null
        && snapshot.value !== undefined && snapshot.value !== null
        ? snapshot.value
        : {}
      const routes = mergeRoutes(routesOf(llmSnapshot), live, published)
      const routeIds = routes.map((route) => route.id)
      // Any route we can offer is enough; only warn when there is nothing at all.
      const routesAvailable = routes.length > 0
      const modelsFor = (provider) => {
        const route = routes.find((candidate) => candidate.id === provider)
        return route === undefined ? [] : route.models
      }

      async function save(nextRows) {
        // Local state keeps every row, drafts included: `toEntries` drops an
        // incomplete row, and adopting that filtered list as state would erase
        // the row the user is still filling in (its `temperature` key would
        // vanish, flipping the cell into "custom" input mode on the next render).
        setRows(nextRows.map((row) => ({
          provider: String(row.provider),
          model: String(row.model),
          temperature: String(row.temperature ?? ''),
        })))
        setBusy(true)
        setMessage(null)
        let ok = false
        try {
          ok = await scope.set('entries', toEntries(nextRows))
        } catch {
          ok = false
        }
        setBusy(false)
        setMessage({ ok, text: ok ? t('saved') : t('failed') })
      }

      /** Dropdown open/close. The key is stable across the save-triggered re-render. */
      const keyOf = (kind, index) => `${kind}:${index}`
      function toggleMenu(key) {
        setOpenKey((current) => (current === key ? null : key))
        setMessage(null)
      }
      const closeMenu = () => setOpenKey(null)

      function patch(index, field, value) {
        setRows(rows.map((row, i) => (i === index ? { ...row, [field]: value } : row)))
      }

      /** Provider changed: the previous model belongs to another route, so clear it. */
      function pickProvider(index, provider) {
        if (provider === CUSTOM) {
          // Hand-typed route: its models are unknowable, so the model cell
          // switches to manual too rather than offering a wrong list. Spread the
          // row: rebuilding it would drop `temperature` and silently flip that
          // cell into its own input mode.
          setRows(rows.map((row, i) => (i === index ? { ...row, provider: CUSTOM, model: CUSTOM } : row)))
          setMessage(null)
          return
        }
        const next = rows.map((row, i) => (i === index ? { provider, model: '' } : row))
        void save(next)
      }

      function pickModel(index, model) {
        if (model === CUSTOM) {
          setRows(rows.map((row, i) => (i === index ? { ...row, model: CUSTOM } : row)))
          setMessage(null)
          return
        }
        void save(rows.map((row, i) => (i === index ? { ...row, model } : row)))
      }

      /** Commit a hand-typed route name. Value is passed in, not read back. */
      function commitProvider(index, value) {
        const provider = String(value).trim()
        if (provider === '') return
        void save(rows.map((row, i) => (i === index ? { ...row, provider } : row)))
      }

      /** Commit a hand-typed model id. */
      function commitModel(index, value) {
        const model = String(value).trim()
        if (model === '') return
        void save(rows.map((row, i) => (i === index ? { ...row, model } : row)))
      }

      function pickTemperature(index, value) {
        // "自定义…" only flips this row into typing mode; nothing is stored yet.
        if (value === CUSTOM) {
          setRows(rows.map((row, i) => (i === index ? { ...row, temperature: CUSTOM } : row)))
          return
        }
        void save(rows.map((row, i) => (i === index ? { ...row, temperature: value } : row)))
      }

      function typeTemperature(index, value) {
        patch(index, 'temperature', value)
      }

      /**
       * Commit the typed value. It is passed in rather than read back from
       * `rows`: typing then blurring in one gesture can reach the handler before
       * the re-render that would carry the new value, and the closure's copy
       * would silently drop what the user typed.
       */
      function commitTemperature(index, value) {
        void save(rows.map((row, i) => (i === index ? { ...row, temperature: value } : row)))
      }

      const head = h(
        'div',
        { className: 'dshtmp-head' },
        h('div', { className: 'dshtmp-th' }, t('colProvider')),
        h('div', { className: 'dshtmp-th' }, t('colModel')),
        h('div', { className: 'dshtmp-th' }, t('colTemp')),
        h('div', null),
      )

      function providerOptions(row) {
        const options = [{ value: '', label: t('choose') }]
        for (const id of routeIds) options.push({ value: id, label: id })
        // A stored route the live/static directory no longer declares stays visible.
        if (row.provider !== '' && row.provider !== CUSTOM && !routeIds.includes(row.provider)) {
          options.push({ value: row.provider, label: `${row.provider} (未在配置中)` })
        }
        /**
         * The manual escape hatch, and the reason it exists: routes registered
         * at runtime by another plugin may not reach this client at all (the
         * live directory is a best-effort read). Without this option the user
         * simply cannot configure such a route — there is nothing to click.
         */
        options.push({ value: CUSTOM, label: t('customProvider') })
        return options
      }

      function modelOptions(row) {
        // An unknown or hand-typed route has no enumerable models: the only
        // honest offer is the manual one.
        if (row.provider === '' || row.provider === CUSTOM) return [{ value: '', label: t('chooseModel') }]
        const models = modelsFor(row.provider)
        if (models.length === 0) {
          const options = [{ value: '', label: t('noModels') }]
          if (row.model !== '' && row.model !== CUSTOM) options.push({ value: row.model, label: row.model })
          options.push({ value: CUSTOM, label: t('customModel') })
          return options
        }
        const options = [{ value: '', label: t('choose') }]
        for (const model of models) {
          /**
           * Label is the display name when one exists, the id otherwise.
           * Channel-gated models are only distinguishable this way: the EAC
           * rows of dsh-our-free-model carry the tag in their name, while their
           * ids (`z-ai/glm-5.3`, `moonshotai/kimi-k3`) look like any other row —
           * showing bare ids made a list that *did* contain them look like it
           * contained only the free ones.
           */
          options.push({ value: model.id, label: model.name === undefined ? model.id : `${model.name} · ${model.id}` })
        }
        if (row.model !== '' && row.model !== CUSTOM && !models.some((model) => model.id === row.model)) {
          options.push({ value: row.model, label: `${row.model} (未在配置中)` })
        }
        options.push({ value: CUSTOM, label: t('customModel') })
        return options
      }

      function temperatureOptions(row) {
        const options = [{ value: '', label: t('phTemp') }]
        for (const value of TEMPERATURES) options.push({ value, label: value })
        options.push({ value: CUSTOM, label: t('custom') })
        // A stored value outside the presets stays selectable, so the row does
        // not silently change what it sends just because the list is short.
        if (row.temperature !== '' && !TEMPERATURES.includes(row.temperature) && row.temperature !== CUSTOM) {
          options.splice(1, 0, { value: row.temperature, label: row.temperature })
        }
        return options
      }

      const body = rows.length === 0
        ? h('p', { className: 'dshtmp-hint' }, t('empty'))
        : rows.map((row, index) => {
            const isCustom = row.temperature === CUSTOM
              || (row.temperature !== '' && !TEMPERATURES.includes(row.temperature))
            const temperatureCell = isCustom
              ? h('input', {
                  className: 'dshtmp-input',
                  value: row.temperature === CUSTOM ? '' : row.temperature,
                  placeholder: t('customPlaceholder'),
                  inputMode: 'decimal',
                  disabled: busy || !writable,
                  onChange: (event) => typeTemperature(index, event.target.value),
                  onBlur: (event) => commitTemperature(index, event.target.value),
                })
              : h(Select, {
                  value: row.temperature,
                  disabled: busy || !writable,
                  options: temperatureOptions(row),
                  open: openKey === keyOf('t', index),
                  onToggle: () => toggleMenu(keyOf('t', index)),
                  onClose: closeMenu,
                  onChange: (value) => pickTemperature(index, value),
                })
            /**
             * Hand-typed cells. `CUSTOM` marks "waiting for the user to type",
             * so the input starts empty and commits on blur — the same contract
             * as the temperature cell, and the reason `toEntries` skips the
             * marker instead of storing it.
             */
            const providerCell = row.provider === CUSTOM
              ? h('input', {
                  className: 'dshtmp-input',
                  value: '',
                  placeholder: t('phProvider'),
                  disabled: busy || !writable,
                  onBlur: (event) => commitProvider(index, event.target.value),
                })
              : h(Select, {
                  value: row.provider,
                  disabled: busy || !writable,
                  options: providerOptions(row),
                  open: openKey === keyOf('p', index),
                  onToggle: () => toggleMenu(keyOf('p', index)),
                  onClose: closeMenu,
                  onChange: (value) => pickProvider(index, value),
                })
            const modelCell = row.model === CUSTOM
              ? h('input', {
                  className: 'dshtmp-input',
                  value: '',
                  placeholder: t('phModel'),
                  disabled: busy || !writable,
                  onBlur: (event) => commitModel(index, event.target.value),
                })
              : h(Select, {
                  value: row.model,
                  disabled: busy || !writable || row.provider === '',
                  options: modelOptions(row),
                  open: openKey === keyOf('m', index),
                  onToggle: () => toggleMenu(keyOf('m', index)),
                  onClose: closeMenu,
                  onChange: (value) => pickModel(index, value),
                })
            return h(
              'div',
              { className: 'dshtmp-row', key: String(index) },
              providerCell,
              modelCell,
              temperatureCell,
              h('button', {
                className: 'dshtmp-btn dshtmp-del',
                type: 'button',
                disabled: busy || !writable,
                /**
                 * Deleting a row shifts every later row up by one, so a key like
                 * `t:1` would suddenly address a different row and that row's
                 * menu would pop open on its own. Close first.
                 */
                onClick: () => {
                  setMessage(null)
                  setOpenKey(null)
                  void save(rows.filter((_, i) => i !== index))
                },
              }, t('remove')),
            )
          })

      return h(
        'div',
        { className: 'dshtmp' },
        h('h2', { className: 'dshtmp-title' }, t('title')),
        h('p', { className: 'dshtmp-intro' }, t('intro')),
        writable ? null : h('p', { className: 'dshtmp-hint' }, t('hintReadOnly')),
        routesAvailable ? null : h('p', { className: 'dshtmp-warn' }, t('hintNoRoutes')),
        h(
          'div',
          { className: 'dshtmp-card' },
          head,
          body,
          h(
            'div',
            { className: 'dshtmp-foot' },
            h('button', {
              className: 'dshtmp-btn',
              type: 'button',
              disabled: busy || !writable,
              onClick: () => { setMessage(null); setRows(addRow(rows)) },
            }, t('add')),
            message === null
              ? null
              : h('span', { className: `dshtmp-msg ${message.ok ? 'dshtmp-ok' : 'dshtmp-err'}` }, message.text),
          ),
        ),
        h('p', { className: 'dshtmp-hint' }, t('boundary')),
      )
    }

    const inject = ['slots', 'locale', 'configForms']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      const scope = ctx.configForms.get(NS)
      const llmScope = ctx.configForms.get(LLM_NS)
      /**
       * The live route registry, best-effort.
       *
       * `remote` is provided by the api-gateway client half, not by this
       * plugin's own dependencies, and cordis throws on a property access for a
       * service that is not in `inject` — so both paths are guarded and a
       * failure simply means "no live directory", never a broken page.
       */
      const getRemote = () => {
        try {
          if (typeof ctx.get === 'function') {
            // `false` = non-strict: return undefined instead of throwing when
            // the service is absent or its providing fiber is not active yet.
            const viaGet = ctx.get('remote', false)
            if (viaGet !== undefined && viaGet !== null) return viaGet
          }
        } catch { /* fall through */ }
        try {
          return ctx.remote
        } catch {
          return undefined
        }
      }
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'per-model-temperature: copy dictionaries')
      ctx.effect(
        () => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'per-model-temperature',
          order: 21,
          label: () => ctx.locale.bind(NS)('nav'),
          inject: () => ({ t, scope, llmScope, getRemote }),
        }, TemperatureSection)),
        'per-model-temperature: settings page',
      )
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
