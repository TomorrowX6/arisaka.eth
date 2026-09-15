const webpack = require('webpack');
const path = require('node:path');

module.exports = {
  publicPath: '/yesplaymusic/',
  productionSourceMap: false,
  parallel: false,
  lintOnSave: false,
  pages: {
    index: {
      entry: 'src/main.js',
      template: 'public/index.html',
      filename: 'index.html',
      title: 'YesPlayMusic',
      chunks: ['main', 'chunk-vendors', 'chunk-common', 'index'],
    },
  },
  chainWebpack(config) {
    config.plugin('define').tap(args => {
      args[0]['process.env'].IS_ELECTRON = 'false';
      return args;
    });
    config.module.rules.delete('svg');
    config.module.rule('svg').exclude.add(path.resolve(__dirname, 'src/assets/icons')).end();
    config.module.rule('icons').test(/\.svg$/)
      .include.add(path.resolve(__dirname, 'src/assets/icons')).end()
      .use('svg-sprite-loader').loader('svg-sprite-loader').options({ symbolId: 'icon-[name]' }).end();
    config.module.rule('webpack4_es_fallback').test(/\.m?js$/)
      .include.add(/node_modules/).end()
      .use('esbuild-loader').loader('esbuild-loader').options({ target: 'es2015', format: 'cjs' }).end();
    config.plugin('chunkPlugin').use(webpack.optimize.LimitChunkCountPlugin, [{ maxChunks: 3, minChunkSize: 10000 }]);
  },
  css: { loaderOptions: { sass: { sassOptions: { quietDeps: true, silenceDeprecations: ['legacy-js-api', 'import', 'global-builtin', 'color-functions'] } } } },
};
