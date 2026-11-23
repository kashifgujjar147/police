module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [['module-resolver', { alias: {
      '@sf/mobile-core': '../../packages/mobile-core/src/index.ts', '@sf/domain': '../../packages/domain/src/index.ts',
      '@sf/i18n': '../../packages/i18n/src/index.ts', '@sf/contracts': '../../packages/contracts/src/index.ts',
    } }]],
  };
};
