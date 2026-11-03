import { describe, expect, it } from 'vitest';
import { BackendClient, BackendError } from '../src/backend/client.js';
import { placeInPicture, sentenceWithPlaces } from '../src/backend/place.js';

type Call = { method: string; path: string; auth: string | null; body: unknown };

function backend(replies: Record<string, (call: Call) => { status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const client = new BackendClient({
    baseUrl: 'http://backend.test',
    email: 'demo@example.test',
    password: 'test',
    companyId: 'company-1',
    fetch: async (url, init) => {
      const { pathname, search } = new URL(String(url));
      const call: Call = {
        method: init?.method ?? 'GET',
        path: pathname + search,
        auth: new Headers(init?.headers).get('authorization'),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      calls.push(call);
      const key = `${call.method} ${pathname}`;
      const reply = replies[key]?.(call) ?? { status: 404, body: { message: `No reply for ${key}` } };
      return new Response(reply.status === 204 ? null : JSON.stringify(reply.body), { status: reply.status ?? 200 });
    },
  });
  return { client, calls };
}

let tokens = 0;
const login = () => ({ body: { data: { token: { accessToken: `token-${++tokens}` } } } });
const RULES = '/portal/v1/companies/company-1/camera-rules';
const draft = { supported: true, name: 'Door', readsAs: 'Tell me if the door opens.', condition: { condition: 'predicate', question: 'Is the door opening?' }, subject: 'a door', severity: 'high', schedule: null };

describe('BackendClient', () => {
  it('logs in once and carries the token on every call', async () => {
    const { client, calls } = backend({
      'POST /portal/auth/login': login,
      [`POST ${RULES}/parse`]: () => ({ body: { data: draft } }),
    });

    await client.parse('Tell me when the door opens.');
    await client.parse('Tell me again.');

    expect(calls.filter((c) => c.path === '/portal/auth/login')).toHaveLength(1);
    const parses = calls.filter((c) => c.path.endsWith('/parse'));
    expect(parses.map((c) => c.body)).toEqual([{ request: 'Tell me when the door opens.' }, { request: 'Tell me again.' }]);
    expect(new Set(parses.map((c) => c.auth)).size).toBe(1);
    expect(parses[0]!.auth).toMatch(/^Bearer token-/);
  });

  it('logs in again when the token has lapsed, and repeats the call', async () => {
    let lapsed = true;
    const { client, calls } = backend({
      'POST /portal/auth/login': login,
      [`POST ${RULES}/parse`]: () => {
        if (lapsed) {
          lapsed = false;
          return { status: 401, body: { message: 'Unauthorized' } };
        }
        return { body: { data: draft } };
      },
    });

    await expect(client.parse('A rule.')).resolves.toMatchObject({ name: 'Door' });
    expect(calls.filter((c) => c.path === '/portal/auth/login')).toHaveLength(2);
  });

  it('saves the draft the person confirmed on the camera, watching the whole picture', async () => {
    const { client, calls } = backend({
      'POST /portal/auth/login': login,
      [`POST ${RULES}`]: () => ({ status: 201, body: { data: { id: 'rule-1' } } }),
    });

    const id = await client.createRule('device-1', 'The sentence.', draft);

    expect(id).toBe('rule-1');
    expect(calls.at(-1)!.body).toEqual({
      deviceId: 'device-1',
      module: 'ai_checks',
      name: 'Door',
      ruleRequest: 'The sentence.',
      scope: 'full_camera',
      condition: draft.condition,
      schedule: null,
      severity: 'high',
      outputAlerts: true,
      enabled: true,
    });
  });

  it('takes a delete that answers with no content as done', async () => {
    const { client, calls } = backend({
      'POST /portal/auth/login': login,
      [`DELETE ${RULES}/rule-1`]: () => ({ status: 204, body: null }),
    });

    await expect(client.deleteRule('rule-1')).resolves.toBeUndefined();
    expect(calls.at(-1)!.method).toBe('DELETE');
  });

  it('shows a refusal in the backend’s own words', async () => {
    const { client } = backend({
      'POST /portal/auth/login': login,
      [`POST ${RULES}`]: () => ({ status: 400, body: { message: 'That camera is not in this company' } }),
    });

    const failure = await client.createRule('device-1', 'The sentence.', draft).catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(BackendError);
    expect((failure as BackendError).message).toBe('That camera is not in this company');
    expect((failure as BackendError).status).toBe(400);
  });

  it('reads every page of a rule’s alerts', async () => {
    const page = (n: number, hasNextPage: boolean) => ({
      body: { data: [{ id: `alert-${n}`, cameraRuleId: 'rule-1', message: 'm', triggeredAt: '2026-11-02T20:00:00.000Z', evidence: { question: 'q', sampledFrames: [] } }], meta: { hasNextPage } },
    });
    const { client } = backend({
      'POST /portal/auth/login': login,
      'GET /portal/v1/companies/company-1/camera-alerts': ({ path }) => (path.includes('page=2') ? page(2, false) : page(1, true)),
    });

    const alerts = await client.alerts('rule-1');

    expect(alerts.map((a) => a.id)).toEqual(['alert-1', 'alert-2']);
  });
});

describe('sentenceWithPlaces', () => {
  const size = { width: 1200, height: 600 };
  const zone = (name: string, left: number, right: number) => ({ name, box: { left, right, top: 200, bottom: 400 } });

  it('names where a zone is, read from its box', () => {
    expect(placeInPicture(zone('a', 900, 1100).box, size)).toBe('on the right side of the picture');
    expect(placeInPicture(zone('a', 50, 300).box, size)).toBe('on the left side of the picture');
    expect(placeInPicture(zone('a', 500, 700).box, size)).toBe('in the middle of the picture');
  });

  it('adds each zone’s place to the sentence, once it ends in a full stop', () => {
    expect(sentenceWithPlaces('Tell me when the front door opens', [zone('front door', 900, 1100)], size)).toBe(
      'Tell me when the front door opens. The front door is on the right side of the picture.',
    );
  });
});
