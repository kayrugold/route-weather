import {bindings, defineConfig, exports} from 'cf/config';

export default defineConfig({
  worker: {
    name: 'atlas-radio',
    compatibilityDate: '2026-11-21',
    entrypoint: './src/index.mjs',
    workersDev: true,
    env: {
      RADIO_ROOM: bindings.durableObject({worker: 'atlas-radio', exportName: 'RadioRoom'}),
      GROUP_DIRECTORY: bindings.durableObject({worker: 'atlas-radio', exportName: 'GroupDirectory'}),
    },
    exports: {
      RadioRoom: exports.durableObject({storage: 'sqlite'}),
      GroupDirectory: exports.durableObject({storage: 'sqlite'}),
    },
    observability: {
      enabled: true,
      redactQueryString: true,
      logs: {enabled: true, invocationLogs: false},
    },
  },
});
