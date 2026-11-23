// Generates docs/openapi.json from the route registry (the same metadata the kernel enforces).
import { writeFileSync } from 'node:fs';
import { testConfig } from '@sf/config';
import { MemoryStore } from '@sf/kernel';
import { createApp } from '../apps/api/src/app.ts';
const app = await createApp({ config: testConfig({ logLevel: 'silent' }), store: new MemoryStore() });
const paths: Record<string, Record<string, unknown>> = {};
for (const r of app.routes) {
  const p = '/api/v1' + r.path.replace(/:(\w+)/g, '{$1}');
  const params = [...r.path.matchAll(/:(\w+)/g)].map((m) => ({ name: m[1], in: 'path', required: true, schema: { type: 'string' } }));
  if (r.query) { const q = r.query.json() as { properties: Record<string, unknown>; required?: string[] }; for (const [n, s] of Object.entries(q.properties)) params.push({ name: n, in: 'query', required: (q.required ?? []).includes(n), schema: s as never }); }
  (paths[p] ??= {})[r.method.toLowerCase()] = {
    summary: r.summary, tags: [r.module], ...(params.length ? { parameters: params } : {}),
    ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: r.body.json() } } } } : {}),
    security: r.permission === 'public' ? [] : [{ bearer: [] }],
    'x-permission': r.permission, 'x-scope': r.scope, 'x-audit': r.audit, 'x-rate-class': r.rate, 'x-device-bound': !!r.deviceBound, 'x-requirements': r.reqs ?? [],
    responses: { '200': { description: 'OK' }, '400': { $ref: '#/components/responses/Error' }, '401': { $ref: '#/components/responses/Error' }, '403': { $ref: '#/components/responses/Error' }, '404': { $ref: '#/components/responses/Error' }, '409': { $ref: '#/components/responses/Error' }, '429': { $ref: '#/components/responses/Error' } },
  };
}
const doc = { openapi: '3.1.0', info: { title: 'SmartForce 360 API', version: '1.0.0', description: 'Generated from the route registry. Every route lists its permission, scope, audit action and rate class.' }, servers: [{ url: '/' }], paths,
  components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT (EdDSA)' } }, responses: { Error: { description: 'Error envelope', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, requestId: { type: 'string' }, fieldErrors: { type: 'array' }, details: { type: 'object' } }, required: ['code', 'message', 'requestId'] } } } } } } } } };
writeFileSync('docs/openapi.json', JSON.stringify(doc, null, 1));
console.log(`openapi: ${app.routes.length} operations on ${Object.keys(paths).length} paths → docs/openapi.json`);
