module.exports = {
  packagerConfig: {
    asar: false,
    executableName: 'Argus',
    authors: 'Argus',
    description: 'Argus standalone local transcription workspace',
    icon: undefined,
    ignore: [/^\/runtime-output\/whisper\.cpp(\/|$)/]
  },
  rebuildConfig: {},
  makers: [
    { name: '@electron-forge/maker-squirrel', config: { name: 'argus_standalone' } },
    { name: '@electron-forge/maker-zip', platforms: ['win32'] }
  ]
};
