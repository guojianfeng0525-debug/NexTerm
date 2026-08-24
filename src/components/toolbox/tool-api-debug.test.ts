import { describe, expect, it } from 'vitest';
import {
  buildApiRequest,
  didCollectionRunPass,
  evaluateApiAssertions,
  parseJsonResponse,
  parseUrlParams,
  runApiCollection,
} from './tool-api-debug';
import type { RequestConfig } from '@/lib/toolbox/api-debug-storage';

const noAuth = {
  type: 'none' as const,
  username: '',
  password: '',
  token: '',
  apiKeyName: '',
  apiKeyValue: '',
  apiKeyIn: 'header' as const,
};

describe('API debug request construction', () => {
  it('uses URLSearchParams without duplicating table params or placing them after a fragment', () => {
    expect(parseUrlParams('https://api.example.test/items?tag=old&tag=second#details')).toEqual([
      ['tag', 'old'],
      ['tag', 'second'],
    ]);

    const request = buildApiRequest({
      method: 'GET',
      url: 'https://api.example.test/items?tag=old&keep=yes#details',
      params: [['tag', 'new'], ['page', '2']],
      headers: [],
      bodyType: 'none',
      bodyText: '',
      auth: noAuth,
      timeoutMs: '30000',
      variables: [],
    });

    expect(request.url).toBe('https://api.example.test/items?keep=yes&tag=new&page=2#details');
  });

  it('resolves environment variables in every authentication field and adds JSON content type', () => {
    const request = buildApiRequest({
      method: 'POST',
      url: 'https://{{host}}/items',
      params: [],
      headers: [],
      bodyType: 'json',
      bodyText: '{"token":"{{token}}"}',
      auth: {
        ...noAuth,
        type: 'basic',
        username: '{{user}}',
        password: '{{password}}',
      },
      timeoutMs: '1000',
      variables: [['host', 'api.example.test'], ['user', 'debugger'], ['password', 'secret'], ['token', 'abc']],
    });

    expect(request.url).toBe('https://api.example.test/items');
    expect(request.body).toBe('{"token":"abc"}');
    expect(request.headers).toEqual([
      ['Authorization', `Basic ${btoa('debugger:secret')}`],
      ['Content-Type', 'application/json'],
    ]);
  });

  it('does not override an explicitly supplied content type', () => {
    const request = buildApiRequest({
      method: 'POST',
      url: 'https://api.example.test/items',
      params: [],
      headers: [['content-type', 'application/problem+json']],
      bodyType: 'json',
      bodyText: '{}',
      auth: noAuth,
      timeoutMs: '30000',
      variables: [],
    });

    expect(request.headers).toEqual([['content-type', 'application/problem+json']]);
  });

  it('uses structured fields for urlencoded and multipart bodies', () => {
    const formRequest = buildApiRequest({
      method: 'POST', url: 'https://api.example.test/items', params: [], headers: [], bodyType: 'form', bodyText: '',
      formFields: [['name', '{{name}}'], ['empty', '']], auth: noAuth, timeoutMs: '30000', variables: [['name', 'NexTerm']],
    });
    const multipartRequest = buildApiRequest({
      method: 'POST', url: 'https://api.example.test/upload', params: [], headers: [], bodyType: 'multipart', bodyText: '',
      formFields: [['description', '{{name}}']], multipartFiles: [{ fieldName: 'upload', fileName: 'test.txt', dataBase64: 'dGVzdA==' }],
      auth: noAuth, timeoutMs: '30000', variables: [['name', 'NexTerm']],
    });

    expect(formRequest.formFields).toEqual([['name', 'NexTerm'], ['empty', '']]);
    expect(formRequest.headers).toEqual([['Content-Type', 'application/x-www-form-urlencoded']]);
    expect(multipartRequest.multipart).toEqual({
      fields: [['description', 'NexTerm']],
      files: [{ fieldName: 'upload', fileName: 'test.txt', dataBase64: 'dGVzdA==' }],
    });
    expect(multipartRequest.headers).toEqual([]);
  });

  it('resolves bearer and query API-key variables without also sending an API-key header', () => {
    const bearerRequest = buildApiRequest({
      method: 'GET',
      url: 'https://api.example.test/items',
      params: [],
      headers: [],
      bodyType: 'none',
      bodyText: '',
      auth: { ...noAuth, type: 'bearer', token: '{{token}}' },
      timeoutMs: '30000',
      variables: [['token', 'bearer-value']],
    });
    const apiKeyRequest = buildApiRequest({
      method: 'GET',
      url: 'https://api.example.test/items#result',
      params: [],
      headers: [],
      bodyType: 'none',
      bodyText: '',
      auth: {
        ...noAuth,
        type: 'apikey',
        apiKeyName: '{{keyName}}',
        apiKeyValue: '{{keyValue}}',
        apiKeyIn: 'query',
      },
      timeoutMs: '30000',
      variables: [['token', 'unused'], ['keyName', 'api_key'], ['keyValue', 'key-value']],
    });

    expect(bearerRequest.headers).toEqual([['Authorization', 'Bearer bearer-value']]);
    expect(apiKeyRequest.url).toBe('https://api.example.test/items?api_key=key-value#result');
    expect(apiKeyRequest.headers).toEqual([]);
  });
});

describe('API debug JSON parsing', () => {
  it.each(['null', 'false', '0', '"text"', '{"brace":"{"}'])('accepts valid JSON response %s', (body) => {
    expect(parseJsonResponse(body).valid).toBe(true);
  });
});

describe('API debug response assertions', () => {
  const response = {
    status: 201,
    statusText: 'Created',
    headers: [['Content-Type', 'application/json'], ['X-Request-Id', 'abc-123']] as [string, string][],
    body: '{"data":{"items":[{"id":7,"tags":["new","featured"]}]}}',
    bodyIsBase64: false,
    durationMs: 125,
  };

  it('evaluates status, case-insensitive headers, JSON paths and response time without scripts', () => {
    expect(evaluateApiAssertions(response, [
      { target: 'status', operator: 'equals', value: '201' },
      { target: 'header', name: 'content-type', operator: 'contains', value: 'json' },
      { target: 'body', path: '$.data.items[0].id', operator: 'equals', value: '7' },
      { target: 'body', path: '$.data.items[0].tags', operator: 'contains', value: 'featured' },
      { target: 'responseTime', operator: 'lessThanOrEqual', value: '200' },
    ]).map((result) => result.passed)).toEqual([true, true, true, true, true]);
  });

  it('rejects unsupported JSON path syntax and reports missing values as failed', () => {
    const [result] = evaluateApiAssertions(response, [
      { target: 'body', path: '$.data.items[?(@.id)]', operator: 'equals', value: '7' },
    ]);
    expect(result).toMatchObject({ passed: false, actual: '(missing)' });
  });
});

describe('API debug collection runner', () => {
  const request = (id: string, url: string): RequestConfig => ({
    id,
    name: id,
    group: 'smoke',
    method: 'GET',
    url,
    params: [],
    headers: [],
    bodyType: 'none',
    bodyText: '',
    auth: noAuth,
    timeoutMs: 30000,
    assertions: [{ target: 'status', operator: 'equals', value: '200' }],
    updatedAt: 0,
  });

  it('runs saved requests in sequence and stops after a failed declarative check', async () => {
    const calls: string[] = [];
    const results = await runApiCollection(
      [request('first', 'https://api.example.test/first'), request('second', 'https://api.example.test/second'), request('third', 'https://api.example.test/third')],
      [],
      async (built) => {
        calls.push(built.url);
        return {
          status: calls.length === 2 ? 500 : 200,
          statusText: '',
          headers: [],
          body: '',
          bodyIsBase64: false,
          durationMs: 10,
        };
      },
      () => false,
      true,
    );

    expect(calls).toEqual(['https://api.example.test/first', 'https://api.example.test/second']);
    expect(results).toHaveLength(2);
    expect(results.map(didCollectionRunPass)).toEqual([true, false]);
  });
});
