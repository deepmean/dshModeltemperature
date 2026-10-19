/**
 * dsh-per-model-temperature — per-model `temperature` for hand-declared
 * `llm-pi-ai` providers.
 *
 * Why a plugin is needed at all: DSH has no `temperature` field on a provider
 * or model profile. The request field exists (`GenerateOptions.temperature` →
 * `LlmCallConfig.temperature` → pi-ai `StreamOptions.temperature`, which
 * `dsh-llm-pi-ai` forwards), but the agent loop seeds its request proposal from
 * the logged session header with only `provider` / `model` / `reasoningEffort`
 * / `maxTokens` — nothing produces a temperature. The loop dispatches
 * `agent/request` and only then calls `llm.prepareCall()`, so a listener that
 * returns a config carrying `temperature` is what puts it on the wire.
 *
 * Scope, deliberately: this plugin writes exactly one thing — the temperature.
 * Reasoning-effort levels and input modalities live in the provider's own
 * `llm-pi-ai` namespace and are already editable by the Model Capability page,
 * so duplicating them here would create two writers for one key.
 *
 * `top_p` / `top_k` are NOT supported and cannot be: neither name exists in
 * `GenerateOptions`, `LlmCallConfig`, or either adapter, and requests are
 * deep-frozen before dispatch, so there is no seam to add a wire field from a
 * plugin. That needs a harness change first.
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'per-model-temperature'
export const inject = ['settings']

/** Settings namespace owned by this plugin. Must match /^[a-z][a-z0-9-]*$/. */
export const NAMESPACE = 'per-model-temperature'

/** Upper bound per route for the published model list (see publishDirectory). */
const MAX_PUBLISHED_MODELS_PER_ROUTE = 40

/** Upper bound across all routes: this list is persisted into the settings file. */
const MAX_PUBLISHED_MODELS = 400

/**
 * One model's declared temperature, keyed by provider route and model id.
 * @typedef {{ provider: string, model: string, temperature?: number }} PerModelEntry
 */

/**
 * Plugin settings section.
 *
 * Exported so the end-to-end probe can push the *persisted* record through the
 * same schema the settings service uses at registration time: if validation
 * dropped or coerced the value, the plugin would silently read `entries: []`
 * and the configured temperature would never reach the wire.
 */
export const settingsSchema = Schema.object({
  entries: Schema.array(
    Schema.object({
      provider: Schema.string().required(),
      model: Schema.string().required(),
      temperature: Schema.number().min(0).max(2),
    }),
  ).default([]),
  /**
   * Live provider routes, published by the server half — read-only for the UI.
   *
   * The settings page used to build its dropdown from the `llm-pi-ai` config
   * section alone, which lists only hand-declared routes. Plugins that call
   * `ctx.llm.registerAdapter()` at runtime (dsh-our-free-model registers
   * `our-free-model` and `our-free-model-region`, @opencode2dsh/dsh-plugin
   * registers `opencode2dsh`) never appear there, so those routes were simply
   * not selectable.
   *
   * The server half can read them, and it publishes them HERE because this
   * document is the channel the page already loads successfully — no reliance
   * on the remote API being reachable from the settings client.
   */
  routes: Schema.array(Schema.string()).default([]),
  /** Model ids per route, published alongside {@link routes}. */
  models: Schema.array(
    Schema.object({
      route: Schema.string().required(),
      model: Schema.string().required(),
      /**
       * Display name from the adapter, when it has one. Channel-gated models are
       * only identifiable by this: dsh-our-free-model tags its EAC rows in the
       * name while the ids look ordinary, so a picker built from ids alone made
       * a complete list look like it held only the free models.
       */
      name: Schema.string(),
    }),
  ).default([]),
})

/**
 * Return the config without a temperature field. The proposal the loop hands
 * plugins is deep-frozen, so removal is a rebuild, never a delete.
 * @param config - the proposal after downstream listeners ran.
 */
function withoutTemperature(config) {
  const { temperature: _dropped, ...rest } = config
  return rest
}

/**
 * Decide one proposal's temperature from the configured entries.
 *
 * The lookup keys on the proposal's own provider and model on every request,
 * because the proposal carries whatever the previous step left there. Without
 * re-deciding, a temperature configured for model A would ride into a
 * mid-session switch to model B, and an unset value would stick the same way.
 *
 * A matching entry with a temperature sets it; a matching entry without one,
 * or no entry at all, drops the field so the provider default applies.
 * @param entries - the configured per-model entries.
 * @param config - the frozen proposal returned by `next()`.
 * @returns a config carrying exactly the temperature this model should send.
 */
export function applyTemperature(entries, config) {
  const list = Array.isArray(entries) ? entries : []
  const entry = list.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === 'object' &&
      candidate.provider === config.provider &&
      candidate.model === config.model,
  )
  if (entry === undefined || typeof entry.temperature !== 'number') {
    return config.temperature === undefined ? config : withoutTemperature(config)
  }
  return { ...config, temperature: entry.temperature }
}

/**
 * Register the per-model temperature producer.
 * @param ctx - the plugin context; `ctx.settings` must be available.
 */
export function apply(ctx) {
  /**
   * Fail with the actual cause, not a bare TypeError.
   *
   * `ctx.settings` is upstream, but `register()` is NOT: dsh 0.2.1-alpha.5's
   * settings service only exposes the new volatile-Config form model, and this
   * legacy method is put back by the dsh-purge patch #42 (SETTINGS_LEGACY_API).
   * A dsh update overwrites `node_modules` and takes it away silently, after
   * which `ctx.settings.register(...)` throws "is not a function" — a message
   * that says nothing about why or what to do.
   */
  if (typeof ctx.settings?.register !== 'function') {
    throw new Error(
      'per-model-temperature: ctx.settings.register() is missing. This plugin uses the legacy settings API, '
      + 'which upstream dsh no longer ships; the dsh-purge patch #42 (SETTINGS_LEGACY_API) restores it. '
      + 'Re-apply the purge patches, restart dsh, then diagnose with: node scripts/check-compat.mjs',
    )
  }
  const scope = ctx.settings.register(NAMESPACE, settingsSchema)
  ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    return applyTemperature(scope.get().entries, config)
  })

  /**
   * Publish the live route/model directory into this plugin's own settings
   * document.
   *
   * Both reads are guarded and optional: a deployment without `llm` or without
   * the session controller simply publishes nothing, and the page keeps
   * working from the static `llm-pi-ai` section. Writing only on change keeps
   * the settings file from churning on every boot.
   */
  const service = (name) => {
    if (typeof ctx.get !== 'function') return undefined
    try {
      // Non-strict: return undefined instead of throwing while the providing
      // fiber is still activating.
      return ctx.get(name, false)
    } catch {
      return undefined
    }
  }

  /**
   * `llm.listModels()` is async — the adapter resolves it. Reading it
   * synchronously is exactly why `models` came back empty once: the catalog
   * helper returns a Promise, and `.groups` on a Promise is always undefined.
   *
   * Routes come from the synchronous registry; models are fetched per route and
   * a single failing route never aborts the rest.
   */
  let publishing = false
  const publishDirectory = async () => {
    if (publishing) return
    publishing = true
    try {
      const routes = []
      const models = []
      const llm = service('llm')
      if (llm !== undefined && llm !== null && typeof llm.listProviders === 'function') {
        try {
          for (const provider of llm.listProviders()) {
            if (provider !== null && typeof provider === 'object' && typeof provider.id === 'string' && provider.id !== '') {
              routes.push(provider.id)
            }
          }
        } catch { /* 目录不可用 */ }
      }
      routes.sort((a, b) => a.localeCompare(b))
      if (routes.length === 0) return

      if (typeof llm.listModels === 'function') {
        for (const route of routes) {
          if (models.length >= MAX_PUBLISHED_MODELS) break
          let list
          try {
            list = await llm.listModels(route)
          } catch {
            continue // 一个路由取不到，不影响其它
          }
          if (!Array.isArray(list)) continue
          let kept = 0
          for (const model of list) {
            if (kept >= MAX_PUBLISHED_MODELS_PER_ROUTE || models.length >= MAX_PUBLISHED_MODELS) break
            if (model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id !== '') {
              const name = typeof model.name === 'string' && model.name !== '' ? model.name : undefined
              models.push(name === undefined ? { route, model: model.id } : { route, model: model.id, name })
              kept += 1
            }
          }
        }
      }
      models.sort((a, b) => a.route.localeCompare(b.route) || a.model.localeCompare(b.model))

      const current = scope.get()
      // Skip the write when nothing moved: this runs on boot and on every
      // adapter change, and a needless write rewrites settings-legacy.yaml.
      if (JSON.stringify(current.routes) === JSON.stringify(routes)
        && JSON.stringify(current.models) === JSON.stringify(models)) return
      try {
        await scope.update({ routes, models })
      } catch { /* 只读部署 */ }
    } finally {
      publishing = false
    }
  }

  // The adapters this needs are registered by other plugins, so retry across
  // boot ordering and again whenever an adapter announces a change.
  for (const delay of [0, 1000, 3000]) {
    const timer = setTimeout(() => { void publishDirectory() }, delay)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  }
  ctx.on('llm/adapters-updated', () => { void publishDirectory() })
}
