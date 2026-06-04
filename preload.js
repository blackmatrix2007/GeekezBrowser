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
    syncGroup: (id) => ipcRenderer.invoke('sync-group', id),
    // License
    licenseGetStatus: () => ipcRenderer.invoke('license-get-status'),
    licenseActivate: (key) => ipcRenderer.invoke('license-activate', key),
    onLicenseActivated: (callback) => ipcRenderer.on('license-activated-ask-data-path', () => callback()),
    dataPathGetConfirmed: () => ipcRenderer.invoke('data-path-get-confirmed'),
    dataPathSetConfirmed: () => ipcRenderer.invoke('data-path-set-confirmed'),
    restartApp: () => ipcRenderer.invoke('restart-app'),
    debugLog: (tag, data) => ipcRenderer.invoke('renderer-debug-log', tag, data),
    // Build info
    isPackaged: () => ipcRenderer.invoke('is-packaged'),
    getPlatform: () => process.platform,
    // ─── BNC Auth ───────────────────────────────────────────────────────────
    bncLogin: (email, password) => ipcRenderer.invoke('bnc-login', { email, password }),
    bncLogout: () => ipcRenderer.invoke('bnc-logout'),
    bncTermsStatus: () => ipcRenderer.invoke('bnc-terms-status'),
    bncTermsAccept: () => ipcRenderer.invoke('bnc-terms-accept'),
    bncGetAuth: () => ipcRenderer.invoke('bnc-get-auth'),
    bncGetPlans: () => ipcRenderer.invoke('bnc-get-plans'),
    bncGetPaymentInfo: () => ipcRenderer.invoke('bnc-get-payment-info'),
    bncGetSubscriptions: () => ipcRenderer.invoke('bnc-get-subscriptions'),
    bncSyncProfiles: () => ipcRenderer.invoke('bnc-sync-profiles'),
    onBncAuthState: (cb) => ipcRenderer.on('bnc-auth-state', (_, data) => cb(data)),
    onProfileSyncStatus: (cb) => ipcRenderer.on('profile-sync-status', (_, data) => cb(data)),
    onBncSlotsUpdated: (cb) => ipcRenderer.on('bnc-slots-updated', (_, data) => cb(data)),
    onBncProfilesReloaded: (cb) => ipcRenderer.on('bnc-profiles-reloaded', () => cb()),
    // ─── Team / Workspace ────────────────────────────────────────────────────
    teamInvite: (data) => ipcRenderer.invoke('bnc-team-invite', data),
    teamGetMembers: () => ipcRenderer.invoke('bnc-team-get-members'),
    teamUpdateMember: (data) => ipcRenderer.invoke('bnc-team-update-member', data),
    teamRemoveMember: (memberId) => ipcRenderer.invoke('bnc-team-remove-member', memberId),
    switchWorkspace: (ownerCustomerId) => ipcRenderer.invoke('bnc-switch-workspace', ownerCustomerId),
    onWorkspaceLoaded: (cb) => ipcRenderer.on('bnc-workspace-loaded', (_, data) => cb(data)),
});