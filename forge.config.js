module.exports = {
  packagerConfig: {
    asar: true,
    prune: true,
    executableName: 'openrotmg-single-player',
    extraResource: ['runtime'],
    ignore: [/^\/(?:\.git[^/]*|\.qa|out|runtime|src|tests|scripts)(?:\/|$)/, /^\/(?:forge\.config\.js|tsconfig(?:\.renderer)?\.json)$/],
    appBundleId: 'org.openrotmg.singleplayer',
    appCategoryType: 'public.app-category.games',
  },
};
