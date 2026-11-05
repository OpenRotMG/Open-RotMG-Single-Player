module.exports = {
  makers: [
    { name: '@electron-forge/maker-wix', config: {
      exe: 'openrotmg-single-player',
      shortName: 'OpenRotMGSinglePlayer',
      upgradeCode: '7522D023-3273-4AE6-B640-96B70E283FA8',
      appUserModelId: 'org.openrotmg.singleplayer',
      defaultInstallMode: 'perUser',
      features: { autoUpdate: false, autoLaunch: false },
      autoRun: false,
      ui: { chooseDirectory: true },
    } },
    { name: '@electron-forge/maker-dmg', config: { format: 'UDZO' } },
    { name: '@electron-forge/maker-zip', platforms: ['linux'], config: {} },
  ],
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
