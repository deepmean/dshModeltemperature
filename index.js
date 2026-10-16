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
  const scope = ctx.settings.register(NAMESPACE, settingsSchema)
  ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    return applyTemperature(scope.get().entries, config)
  })
}
