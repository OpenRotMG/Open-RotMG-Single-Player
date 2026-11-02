module.exports = {
  packagerConfig: {
    asar: true,
    executableName: 'openrotmg-single-player',
    extraResource: ['runtime'],
    ignore: [/^\/(?:\.git[^/]*|\.qa|out|runtime|src|tests|scripts|node_modules)(?:\/|$)/, /^\/(?:forge\.config\.js|tsconfig(?:\.renderer)?\.json)$/],
    appBundleId: 'org.openrotmg.singleplayer',
    appCategoryType: 'public.app-category.games',
  },
};
