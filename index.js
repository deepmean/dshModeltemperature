/**
 * dsh-per-model-temperature — per-model `temperature` for llm-pi-ai routes.
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
 * ── Why this file looks the way it does ──────────────────────────────────
 *
 * CONFIG IS NATIVE. This plugin used to call `ctx.settings.register(...)`, the
 * "legacy settings API". That method is NOT dsh code: it was added by the
 * `dsh-purge` patch #42, so the plugin only worked on machines carrying that
 * patch — and every dsh update overwrote the patched file and silently broke
 * it. Three separate updates did exactly that.
 *
 * Now the plugin declares a plain `Config` schema whose fields are `.volatile()`
 * and lets cordis own the storage, exactly like `dsh-llm-deepseek` does with its
 * volatile `models` array. That buys three things:
 *
 *   1. No dependency on any patched dsh file. A clean `dsh` install works.
 *   2. The settings page reads and writes through `ctx.configForms` →
 *      `settings.describe`/`mutate`, which are core APIs, not patch output.
 *   3. Values persist in the profile's cordis patch (the same place every other
 *      plugin keeps its config), not in a private side file.
 *
 * `routes` / `models` are published by the server half into its own config so
 * the page can offer provider routes that only exist at runtime (plugins that
 * call `ctx.llm.registerAdapter()`), without depending on the remote directory
 * API being reachable from the settings client.
 *
 * `top_p` / `top_k` are NOT supported and cannot be: neither name exists in
 * `GenerateOptions`, `LlmCallConfig`, or either adapter, and requests are
 * deep-frozen before dispatch, so there is no seam to add a wire field from a
 * plugin. That needs a harness change first.
 */

import Schema from '@deepseek-ai/schemastery'

export const name = 'per-model-temperature'

/** Profile entry id: also the settings namespace the page talks to. */
export const ENTRY_ID = 'per-model-temperature'

/**
 * Plugin config. Every field is volatile, which is what makes it editable from
 * the settings page: `settings.describe` only lists an entry that has volatile
 * fields, and `settings.mutate` refuses paths that are not volatile.
 */
export const Config = Schema.object({
  entries: Schema.array(
    Schema.object({
      provider: Schema.string().required(),
      model: Schema.string().required(),
      temperature: Schema.number().min(0).max(2),
    }),
  ).default([]).volatile(),
  /**
   * Live provider routes, published by the server half — read-only for the UI.
   *
   * The settings page used to build its dropdown from the `llm-pi-ai` config
   * section alone, which lists only hand-declared routes. Plugins that call
   * `ctx.llm.registerAdapter()` at runtime (dsh-our-free-model registers
   * `our-free-model` and `our-free-model-region`, @opencode2dsh/dsh-plugin
   * registers `opencode2dsh`) never appear there, so those routes were simply
   * not selectable.
   */
  routes: Schema.array(Schema.string()).default([]).volatile(),
  /** Model ids per route, published alongside {@link routes}. */
  models: Schema.array(
    Schema.object({
      route: Schema.string().required(),
      model: Schema.string().required(),
      /**
       * Display name from the adapter, when it has one. Channel-gated models
       * are only identifiable by this: dsh-our-free-model tags its EAC rows in
       * the name while the ids look ordinary, so a picker built from ids alone
       * made a complete list look like it held only the free models.
       */
      name: Schema.string(),
    }),
  ).default([]).volatile(),
})

/** Upper bound per route for the published model list (see publishDirectory). */
const MAX_PUBLISHED_MODELS_PER_ROUTE = 40

/** Upper bound across all routes: this list is persisted with the plugin config. */
const MAX_PUBLISHED_MODELS = 400

/**
 * One model's declared temperature, keyed by provider route and model id.
 * @typedef {{ provider: string, model: string, temperature?: number }} PerModelEntry
 */

/**
 * Unwrap a volatile ref, or pass a plain value through.
 *
 * Config fields are volatile refs when cordis resolves this plugin's config
 * (`ref.get()`), but a plain object is what the probes and any non-ref host
 * hand over. Accepting both keeps the seam testable without a live harness.
 * @param ref - volatile ref, plain value, or undefined.
 */
function valueOf(ref) {
  if (ref === null || ref === undefined) return undefined
  return typeof ref.get === 'function' ? ref.get() : ref
}

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

/** Resolve a service without demanding it in `inject`. */
function serviceOf(ctx) {
  return (name) => {
    if (typeof ctx.get !== 'function') return undefined
    try {
      // Non-strict: undefined instead of throwing while the provider is still
      // activating.
      return ctx.get(name, false)
    } catch {
      return undefined
    }
  }
}

/**
 * Register the per-model temperature producer.
 *
 * Nothing here throws: a failure to publish the directory or to migrate the old
 * side file must not take the plugin (or the harness boot) down with it. The
 * one thing that must work — the request listener — is registered first and
 * cannot fail.
 *
 * @param ctx - the plugin context.
 * @param config - resolved plugin config; volatile fields arrive as refs.
 */
export function apply(ctx, config) {
  const service = serviceOf(ctx)

  /** Current entries, from whichever shape the host provided. */
  const entriesOf = () => {
    const value = valueOf(config?.entries)
    return Array.isArray(value) ? value : []
  }

  ctx.on('agent/request', async (_payload, next) => {
    const proposal = await next()
    return applyTemperature(entriesOf(), proposal)
  })

  /**
   * Write fields into this plugin's own entry config through the config editor.
   *
   * This is the native write path (`configEditor.edit(entry, change)`), the one
   * `dsh-agent-default-model` uses to save a model selection. It needs no
   * settings service and no patched dsh file. The entry is located by id rather
   * than through `fiber.entry` so this works identically for a function plugin.
   *
   * @param patch - fields to merge into the entry config.
   * @returns whether the write happened.
   */
  async function writeConfig(patch) {
    const editor = service('configEditor')
    if (editor === undefined || editor === null) return false
    if (typeof editor.edit !== 'function' || typeof editor.entries !== 'function') return false
    let entry
    try {
      entry = editor.entries().find((row) => row?.options?.id === ENTRY_ID)
    } catch {
      return false
    }
    if (entry === undefined) return false
    try {
      await editor.edit(entry, (current) => ({ ...current, ...patch }))
      return true
    } catch {
      return false
    }
  }

  /**
   * Publish the live route/model directory, and migrate the pre-native config.
   *
   * Both are best-effort and both run across a few delays: `llm` and the
   * adapters are provided by other plugins, so boot ordering is not guaranteed.
   * Writes are skipped when nothing changed — otherwise every boot would
   * rewrite the profile patch.
   *
   * What was last written is remembered here rather than read back from the
   * config ref: `configEditor.edit` commits the new value to the loader, but the
   * ref this closure holds may still report the old one until the commit
   * lands. Comparing against the ref alone therefore rewrote the same content
   * on the next retry, which is exactly the churn the guard is meant to stop.
   */
  let running = false
  let lastDirectory = null
  let migrated = false
  const refresh = async () => {
    if (running) return
    running = true
    try {
      await migrateLegacyEntries()
      await publishDirectory()
    } finally {
      running = false
    }
  }

  /**
   * One-time move of the old side file into native config.
   *
   * Before this migration the entries lived in `settings-legacy.yaml`, owned by
   * the legacy settings API. That file is left untouched (a rollback might want
   * it), and the move only happens when the native config still has no entries,
   * so it cannot overwrite later edits.
   */
  async function migrateLegacyEntries() {
    if (migrated) return
    if (entriesOf().length > 0) { migrated = true; return }
    const legacy = service('profileContext')
    const home = legacy?.home
    if (typeof home !== 'string' || home === '') return
    let document
    try {
      const { readFileSync } = await import('node:fs')
      const { join } = await import('node:path')
      const { parse } = await import('yaml')
      const path = join(home, 'settings-legacy.yaml')
      document = parse(readFileSync(path, 'utf8'))
    } catch {
      return
    }
    const section = document?.[ENTRY_ID]
    const stored = Array.isArray(section?.entries) ? section.entries : []
    const entries = stored
      .filter((row) => row !== null && typeof row === 'object')
      .map((row) => ({
        provider: String(row.provider ?? '').trim(),
        model: String(row.model ?? '').trim(),
        ...(typeof row.temperature === 'number' ? { temperature: row.temperature } : {}),
      }))
      .filter((row) => row.provider !== '' && row.model !== '')
    if (entries.length === 0) return
    const ok = await writeConfig({ entries })
    if (ok) {
      migrated = true
      ctx.logger?.info?.(
        'per-model-temperature: migrated %d entr(ies) out of settings-legacy.yaml into native config',
        entries.length,
      )
    }
  }

  /** Collect the route/model directory from the live registry and publish it. */
  async function publishDirectory() {
    const llm = service('llm')
    if (llm === undefined || llm === null || typeof llm.listProviders !== 'function') return

    const routes = []
    try {
      for (const provider of llm.listProviders()) {
        if (provider !== null && typeof provider === 'object' && typeof provider.id === 'string' && provider.id !== '') {
          routes.push(provider.id)
        }
      }
    } catch {
      return
    }
    if (routes.length === 0) return
    routes.sort((a, b) => a.localeCompare(b))

    const models = []
    if (typeof llm.listModels === 'function') {
      for (const route of routes) {
        if (models.length >= MAX_PUBLISHED_MODELS) break
        let list
        try {
          // Async: the adapter resolves this. A synchronous read here is what
          // once produced an empty model list with no error at all.
          list = await llm.listModels(route)
        } catch {
          continue // one route failing must not abort the pass
        }
        if (!Array.isArray(list)) continue
        let kept = 0
        for (const model of list) {
          if (kept >= MAX_PUBLISHED_MODELS_PER_ROUTE || models.length >= MAX_PUBLISHED_MODELS) break
          if (model !== null && typeof model === 'object' && typeof model.id === 'string' && model.id !== '') {
            const label = typeof model.name === 'string' && model.name !== '' ? model.name : undefined
            models.push(label === undefined ? { route, model: model.id } : { route, model: model.id, name: label })
            kept += 1
          }
        }
      }
    }
    models.sort((a, b) => a.route.localeCompare(b.route) || a.model.localeCompare(b.model))

    const currentRoutes = valueOf(config?.routes)
    const currentModels = valueOf(config?.models)
    const sameAsWrite = lastDirectory !== null
      && JSON.stringify(lastDirectory.routes) === JSON.stringify(routes)
      && JSON.stringify(lastDirectory.models) === JSON.stringify(models)
    const sameAsRef = JSON.stringify(currentRoutes) === JSON.stringify(routes)
      && JSON.stringify(currentModels) === JSON.stringify(models)
    if (sameAsWrite || sameAsRef) {
      lastDirectory = { routes, models }
      return
    }

    const ok = await writeConfig({ routes, models })
    if (ok) lastDirectory = { routes, models }
  }

  // Retry across boot ordering, then again whenever an adapter announces a change.
  for (const delay of [0, 1000, 3000]) {
    const timer = setTimeout(() => { void refresh() }, delay)
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') timer.unref()
  }
  ctx.on('llm/adapters-updated', () => { void refresh() })
}
