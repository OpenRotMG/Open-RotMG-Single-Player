module.exports = {
  // scripts/make-zip.mjs builds the portable ZIP around the packaged app.
  makers: [],
  packagerConfig: {
    asar: true,
    prune: true,
    executableName: 'openrotmg-single-player',
    extraResource: ['runtime','launcher/THIRD-PARTY-NOTICES.txt'],
    ignore: [/^\/(?:\.git[^/]*|\.qa|out|runtime|src|tests|scripts|launcher)(?:\/|$)/, /^\/(?:forge\.config\.js|tsconfig(?:\.renderer)?\.json)$/],
    appBundleId: 'org.openrotmg.singleplayer',
    appCategoryType: 'public.app-category.games',
  },
};
