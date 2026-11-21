import {bindings, defineConfig, exports} from 'cf/config';

export default defineConfig({
  worker: {
    name: 'route-weather',
    compatibilityDate: '2026-11-21',
    entrypoint: './cloud/index.mjs',
    workersDev: true,
    assets: {runWorkerFirst: ['/', '/*.html', '/api/*', '/app-api/*']},
    env: {
      ASSETS: bindings.assets(),
      QUOTA: bindings.durableObject({worker: 'route-weather', exportName: 'TripQuota'}),
      CLIENT_RATE: bindings.rateLimit({namespace: '10201', simple: {limit: 60, period: 60}}),
      STUDIO_TRAFFIC: bindings.text('off'),
    },
    exports: {TripQuota: exports.durableObject({storage: 'sqlite'})},
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: {enabled: true, invocationLogs: false},
      traces: {enabled: true, headSamplingRate: 0},
    },
  },
});
