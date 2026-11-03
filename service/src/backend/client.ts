import { z } from 'zod';

// What the backend's rule parse returns, kept whole so the save sends back exactly what the person confirmed.
const ruleDraft = z.looseObject({
  supported: z.boolean(),
  name: z.string().nullish(),
  readsAs: z.string().nullish(),
  condition: z.record(z.string(), z.unknown()).nullish(),
  subject: z.string().nullish(),
  severity: z.string().nullish(),
  schedule: z.unknown().nullish(),
  refusal: z.string().nullish(),
  rewrites: z.array(z.string()).nullish(),
});
export type RuleDraft = z.infer<typeof ruleDraft>;

const probeResult = z.object({
  answerableCount: z.number(),
  warns: z.boolean(),
  cameras: z.array(z.looseObject({ reason: z.string().nullish(), rewrites: z.array(z.string()).nullish() })),
});

const sampledFrame = z.object({ objectKey: z.string(), capturedAt: z.number(), storageProvider: z.string().nullish() });
const backendAlert = z.object({
  id: z.string(),
  cameraRuleId: z.string().nullable(),
  message: z.string(),
  triggeredAt: z.string(),
  evidence: z.looseObject({ question: z.string().nullish(), sampledFrames: z.array(sampledFrame).nullish() }),
});
export type BackendAlert = z.infer<typeof backendAlert>;
export type SampledFrame = z.infer<typeof sampledFrame>;

const replayStretch = z.looseObject({ startIso: z.string(), endIso: z.string(), frameUrl: z.string().nullish() });
const replayView = z.looseObject({
  id: z.string(),
  status: z.string(),
  answer: z.string().nullish(),
  counted: z.looseObject({ coverage: z.looseObject({ framesRead: z.number(), framesRecorded: z.number() }).nullish() }).nullish(),
  stretches: z.array(replayStretch).nullish(),
});
export type ReplayView = z.infer<typeof replayView>;

const demoScenarioSummary = z.looseObject({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  position: z.number(),
  setId: z.string().nullish(),
  status: z.string(),
  fromAt: z.string(),
  toAt: z.string(),
});
export type DemoScenarioSummary = z.infer<typeof demoScenarioSummary>;
const demoScenarioDetail = demoScenarioSummary.extend({
  rules: z.array(z.looseObject({ id: z.string(), name: z.string(), readsAs: z.string().nullish() })),
  alerts: z.array(z.looseObject({ ruleId: z.string(), triggeredAt: z.string() })),
  playback: z.looseObject({ kind: z.string(), url: z.string().nullish() }),
});
const demoAlert = z.looseObject({
  key: z.string(),
  ruleId: z.string().optional(),
  draftRuleId: z.string().optional(),
  triggeredAt: z.string(),
  shownAt: z.string(),
  delayMs: z.number(),
  message: z.string(),
  severity: z.string(),
  evidenceFrame: z.looseObject({ url: z.string(), caption: z.string().nullish() }).nullish(),
});
export type DemoAlert = z.infer<typeof demoAlert>;
const demoTypedRule = z.looseObject({
  id: z.string(),
  text: z.string(),
  status: z.string(),
  progress: z.looseObject({ done: z.number(), total: z.number().nullable() }),
  rule: z.looseObject({ name: z.string(), readsAs: z.string().nullish() }).nullish(),
  refusal: z.looseObject({ rewrites: z.array(z.string()).nullish(), reason: z.string().nullish() }).nullish(),
  probe: z.looseObject({ warns: z.boolean().nullish() }).nullish(),
});
export type DemoTypedRule = z.infer<typeof demoTypedRule>;
export type DemoScheduleRule = { ruleId: string; armedAt: string } | { draftRuleId: string };

// The backend writes its refusals for the person, so they are shown as they are.
export class BackendError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const ALERTS_PER_PAGE = 50;
const STRETCHES_SHOWN = 50;

export interface StoredAsk {
  question: string;
  verdict: boolean;
  settledBy: 'one-picture' | 'change' | 'brief-change';
  deviceId: string;
  from: Date;
  to: Date;
}

export type RuleBackend = Pick<
  BackendClient,
  'parse' | 'probe' | 'createRule' | 'deleteRule' | 'alerts' | 'pictureUrls' | 'estimateQuestion' | 'startQuestion' | 'replay'
>;

// Calls Streamatic's existing rule API as a company's user, as any client of the product does.
export class BackendClient {
  #token: string | null = null;

  constructor(
    private readonly options: { baseUrl: string; email: string; password: string; companyId: string; fetch?: typeof fetch },
  ) {}

  async parse(request: string): Promise<RuleDraft> {
    return ruleDraft.parse(await this.#company('POST', '/camera-rules/parse', { request }));
  }

  async probe(deviceId: string, request: string, draft: RuleDraft) {
    return probeResult.parse(
      await this.#company('POST', '/camera-rules/probe', {
        request,
        question: draft.condition?.question,
        subject: draft.subject ?? null,
        schedule: draft.schedule ?? null,
        targetKind: 'camera',
        deviceId,
      }),
    );
  }

  async createRule(deviceId: string, request: string, draft: RuleDraft): Promise<string> {
    const { id } = z.object({ id: z.string() }).parse(
      await this.#company('POST', '/camera-rules', {
        deviceId,
        module: 'ai_checks',
        name: draft.name,
        ruleRequest: request,
        scope: 'full_camera',
        condition: draft.condition,
        schedule: draft.schedule ?? null,
        severity: draft.severity ?? 'medium',
        outputAlerts: true,
        enabled: true,
      }),
    );
    return id;
  }

  async deleteRule(id: string): Promise<void> {
    await this.#call('DELETE', `/portal/v1/companies/${this.options.companyId}/camera-rules/${id}`);
  }

  async alerts(ruleId: string): Promise<BackendAlert[]> {
    const alerts: BackendAlert[] = [];
    for (let page = 1; ; page++) {
      const query = `cameraRuleId=${ruleId}&page=${page}&take=${ALERTS_PER_PAGE}`;
      const reply = await this.#call('GET', `/portal/v1/companies/${this.options.companyId}/camera-alerts?${query}`);
      const { data, meta } = z.object({ data: z.array(backendAlert), meta: z.object({ hasNextPage: z.boolean() }) }).parse(reply);
      alerts.push(...data);
      if (!meta.hasNextPage) return alerts;
    }
  }

  // Signed addresses for stored pictures, which also reach a picture inside one of the camera's batches.
  async pictureUrls(keys: string[]): Promise<Record<string, string>> {
    return z.record(z.string(), z.string()).parse(await this.#company('POST', '/scene-intelligence/frame-urls', { storageKeys: keys }));
  }

  // What asking a draft's question over stored pictures would cost; it runs only at the price the person confirmed.
  async estimateQuestion(ask: StoredAsk): Promise<{ costMicroUsd: number | null; reason: string | null }> {
    const query = new URLSearchParams({
      question: ask.question,
      verdict: String(ask.verdict),
      settledBy: ask.settledBy,
      deviceIds: ask.deviceId,
      fromIso: ask.from.toISOString(),
      toIso: ask.to.toISOString(),
    });
    const { outcome, estimate } = z
      .looseObject({ outcome: z.string(), estimate: z.looseObject({ costMicroUsd: z.number().nullish() }).nullish() })
      .parse(await this.#company('GET', `/narrative-search/replay-estimate?${query}`));
    return outcome === 'estimated' ? { costMicroUsd: estimate?.costMicroUsd ?? null, reason: null } : { costMicroUsd: null, reason: outcome };
  }

  async startQuestion(ask: StoredAsk, asked: string, confirmedCostMicroUsd: number | null): Promise<string> {
    const started = await this.#company('POST', '/narrative-search/replays', {
      question: ask.question,
      verdict: ask.verdict,
      settledBy: ask.settledBy,
      deviceIds: [ask.deviceId],
      questionKind: 'existence',
      fromIso: ask.from.toISOString(),
      toIso: ask.to.toISOString(),
      asked,
      confirmedCostMicroUsd,
    });
    return z.looseObject({ id: z.string() }).parse(started).id;
  }

  async replay(id: string): Promise<ReplayView> {
    return replayView.parse(await this.#company('GET', `/narrative-search/replays/${id}?take=${STRETCHES_SHOWN}`));
  }

  async demoSetId(name: string): Promise<string | null> {
    const reply = await this.#call('GET', `/portal/v1/companies/${this.options.companyId}/demo-scenario-sets?q=${encodeURIComponent(name)}&take=50`);
    const { data } = z.object({ data: z.array(z.looseObject({ id: z.string(), name: z.string() })) }).parse(reply);
    return data.find((set) => set.name === name)?.id ?? null;
  }

  async demoScenarios(): Promise<DemoScenarioSummary[]> {
    const reply = await this.#call('GET', `/portal/v1/companies/${this.options.companyId}/demo-scenarios?take=50`);
    return z.object({ data: z.array(demoScenarioSummary) }).parse(reply).data;
  }

  async demoScenario(id: string) {
    return demoScenarioDetail.parse(await this.#company('GET', `/demo-scenarios/${id}`));
  }

  async demoSchedule(id: string, rules: DemoScheduleRule[]) {
    return z.object({ alerts: z.array(demoAlert) }).parse(await this.#company('POST', `/demo-scenarios/${id}/schedules`, { rules, timing: 'real-delay' }));
  }

  async typeDemoRule(id: string, text: string): Promise<string> {
    return z.object({ draftRuleId: z.string() }).parse(await this.#company('POST', `/demo-scenarios/${id}/draft-rules`, { text })).draftRuleId;
  }

  async demoRule(id: string, draft: string): Promise<DemoTypedRule> {
    return demoTypedRule.parse(await this.#company('GET', `/demo-scenarios/${id}/draft-rules/${draft}`));
  }

  async #company(method: string, path: string, body?: unknown): Promise<unknown> {
    const { data } = z.object({ data: z.unknown() }).parse(await this.#call(method, `/portal/v1/companies/${this.options.companyId}${path}`, body));
    return data;
  }

  async #call(method: string, path: string, body?: unknown): Promise<unknown> {
    const first = await this.#send(method, path, body, await this.#currentToken());
    if (first.status !== 401) return readReply(first);
    this.#token = null;
    return readReply(await this.#send(method, path, body, await this.#currentToken()));
  }

  async #currentToken(): Promise<string> {
    if (this.#token) return this.#token;
    const { email, password } = this.options;
    const reply = await readReply(await this.#send('POST', '/portal/auth/login', { email, password }, null));
    this.#token = z.object({ data: z.object({ token: z.object({ accessToken: z.string() }) }) }).parse(reply).data.token.accessToken;
    return this.#token;
  }

  #send(method: string, path: string, body: unknown, token: string | null): Promise<Response> {
    const { baseUrl, fetch: send = fetch } = this.options;
    return send(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }
}

async function readReply(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch(() => null);
  if (response.ok) return body;
  const { message } = z.looseObject({ message: z.union([z.string(), z.array(z.string())]).optional() }).catch({}).parse(body ?? {});
  const said = Array.isArray(message) ? message.join(' ') : message;
  throw new BackendError(response.status, said ?? 'Streamatic could not complete the request.');
}
