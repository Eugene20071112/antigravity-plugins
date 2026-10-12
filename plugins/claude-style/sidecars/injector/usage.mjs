// Pure metadata interpretation; these are client-observed timings, not a
// measurement of the provider's internal decoding speed.
const number = (v) => v == null || v === '' ? null : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null;
export const seconds = (v) => typeof v === 'string' && /^\d+(?:\.\d+)?s$/.test(v) ? number(v.slice(0, -1)) : null;
const count = (v) => number(v) ?? 0;

export function summarizeUsage(records, configs = []) {
  const totals = { input: 0, output: 0, thinking: 0, cacheRead: 0, generations: 0, streaming: 0, streamedOutput: 0, speedSamples: 0, elapsed: 0, timedOutput: 0 };
  let last = null;
  for (const gm of records) {
    const chat = gm.chatModel;
    const u = chat?.usage;
    if (!u) continue;
    const output = count(u.outputTokens);
    const thinking = count(u.thinkingOutputTokens);
    // Proto JSON omits zero-valued scalars. Fall back only when a total is
    // actually present; absent usage must not become a measured zero rate.
    const response = number(u.responseOutputTokens) ?? (number(u.outputTokens) == null ? null : Math.max(0, output - thinking));
    const streaming = seconds(chat.streamingDuration);
    const ttft = seconds(chat.timeToFirstToken);
    const elapsed = streaming != null && ttft != null ? streaming + ttft : null;
    // Very short streams are often buffered tool-call responses. Keep their
    // usage totals, but do not present their burst rate as a decoding speed.
    const tps = streaming >= 0.5 && response > 0 ? response / streaming : null;
    const requestedModel = chat.model || u.model || null;
    const config = configs.find((c) => c.modelOrAlias?.model === requestedModel);
    const ctx = chat.chatStartMetadata?.contextWindowMetadata;
    last = {
      requestedModel, requestedLabel: config?.label || requestedModel,
      requestedModelId: config?.modelId || null,
      responseModel: chat.responseModel || null,
      modelSource: chat.responseModel ? 'chatModel.responseModel' : null,
      input: count(u.inputTokens), output, thinking, response, cacheRead: count(u.cacheReadTokens),
      ttft, streaming, elapsed, tps,
      effectiveTps: elapsed > 0 && number(u.outputTokens) != null ? output / elapsed : null,
      contextUsed: number(ctx?.estimatedTokensUsed) ?? number(ctx?.tokenBreakdown?.totalTokens),
      contextMax: number(ctx?.maxContextTokens),
      breakdown: (ctx?.tokenBreakdown?.groups ?? []).map((g) => ({ name: g.name, tokens: count(g.numTokens) })),
    };
    for (const key of ['input', 'output', 'thinking', 'cacheRead']) totals[key] += last[key];
    totals.generations++;
    if (tps != null) {
      totals.streaming += streaming;
      totals.streamedOutput += response;
      totals.speedSamples++;
    }
    if (last.effectiveTps != null) {
      totals.elapsed += elapsed;
      totals.timedOutput += output;
    }
  }
  return { last, totals };
}

export function createUsageReader(lsCall) {
  // Replay snapshots: entries may be amended after first appearing, and a
  // conversation may rewind. Offset-only accumulation cannot handle either.
  const pending = new Map();
  let configs = [], configTime = 0, configPending = null;
  async function models() {
    if (Date.now() - configTime < 300000) return configs;
    if (!configPending) configPending = lsCall('GetCascadeModelConfigData', {}).then((r) => {
      configs = r.clientModelConfigs ?? []; configTime = Date.now(); return configs;
    }).catch(() => configs).finally(() => { configPending = null; });
    return configPending;
  }
  return function usage(cascadeId) {
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(String(cascadeId))) return Promise.resolve(null);
    if (pending.has(cascadeId)) return pending.get(cascadeId);
    const request = Promise.all([
      lsCall('GetCascadeTrajectoryGeneratorMetadata', { cascadeId, generatorMetadataOffset: 0 }), models(),
    ]).then(([res, cfg]) => summarizeUsage(res.generatorMetadata ?? [], cfg))
      .finally(() => pending.delete(cascadeId));
    pending.set(cascadeId, request);
    return request;
  };
}
