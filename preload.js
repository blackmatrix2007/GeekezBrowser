// preload.js
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
    getProfiles: () => ipcRenderer.invoke('get-profiles'),
    saveProfile: (data) => ipcRenderer.invoke('save-profile', data),
    updateProfile: (data) => ipcRenderer.invoke('update-profile', data),
    deleteProfile: (id) => ipcRenderer.invoke('delete-profile', id),
    launchProfile: (id, watermarkStyle) => ipcRenderer.invoke('launch-profile', id, watermarkStyle),
    getSettings: () => ipcRenderer.invoke('get-settings'),
    saveSettings: (data) => ipcRenderer.invoke('save-settings', data),
    exportProfile: (id) => ipcRenderer.invoke('export-profile', id),
    importProfile: () => ipcRenderer.invoke('import-profile'),
    // Auto-detect proxy geolocation
    detectProxyLocation: (proxyStr) => ipcRenderer.invoke('detect-proxy-location', proxyStr),
    // 通用 invoke，用于 open-url 等
    invoke: (channel, data) => ipcRenderer.invoke(channel, data),
    getRunningIds: () => ipcRenderer.invoke('get-running-ids'),
    onProfileStatus: (callback) => ipcRenderer.on('profile-status', (event, data) => callback(data)),
    // API events
    onRefreshProfiles: (callback) => ipcRenderer.on('refresh-profiles', () => callback()),
    onApiLaunchProfile: (callback) => ipcRenderer.on('api-launch-profile', (event, id) => callback(id)),
    verifyProfile: (id) => ipcRenderer.invoke('verify-profile', id),
    onVerifyProgress: (callback) => ipcRenderer.on('verify-progress', (event, data) => callback(data)),
    getChromePath: () => ipcRenderer.invoke('get-chrome-path'),
    selectChromeBinary: () => ipcRenderer.invoke('select-chrome-binary'),
    clearChromeBinary: () => ipcRenderer.invoke('clear-chrome-binary'),
    checkFingerprintChromium: () => ipcRenderer.invoke('check-fingerprint-chromium'),
    downloadFingerprintChromium: () => ipcRenderer.invoke('download-fingerprint-chromium'),
    onFpChromiumProgress: (callback) => ipcRenderer.on('fp-chromium-progress', (event, data) => callback(data)),
    // Chrome for Testing (Google official Chromium — real canvas fingerprint)
    checkChromeForTesting: () => ipcRenderer.invoke('check-chrome-for-testing'),
    downloadChromeForTesting: () => ipcRenderer.invoke('download-chrome-for-testing'),
    onCftProgress: (callback) => ipcRenderer.on('cft-progress', (event, data) => callback(data)),
    // Profile Groups
    getGroups: () => ipcRenderer.invoke('get-groups'),
    saveGroup: (data) => ipcRenderer.invoke('save-group', data),
    updateGroup: (data) => ipcRenderer.invoke('update-group', data),
    deleteGroup: (id) => ipcRenderer.invoke('delete-group', id),
    assignProfileGroup: (profileId, groupId) => ipcRenderer.invoke('assign-profile-group', { profileId, groupId }),
    // License
    licenseGetStatus: () => ipcRenderer.invoke('license-get-status'),
    licenseActivate: (key) => ipcRenderer.invoke('license-activate', key),
});