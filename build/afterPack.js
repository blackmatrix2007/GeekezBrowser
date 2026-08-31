const { execSync } = require('child_process');

exports.default = async function (context) {
    const appPath = `${context.appOutDir}/${context.packager.appInfo.productFilename}.app`;
    try {
        // Remove AppleDouble files and extended attributes from extraResources (Chrome, bin)
        // so they are NOT included in the codesign seal, allowing ZIP extraction to pass verification.
        execSync(`find "${appPath}/Contents/Resources/puppeteer" -name '._*' -delete 2>/dev/null; true`);
        execSync(`find "${appPath}/Contents/Resources/bin" -name '._*' -delete 2>/dev/null; true`);
        execSync(`xattr -rc "${appPath}/Contents/Resources/puppeteer" 2>/dev/null; true`);
        execSync(`xattr -rc "${appPath}/Contents/Resources/bin" 2>/dev/null; true`);
        console.log('  • afterPack: stripped ._* and xattrs from extraResources before signing');
    } catch (_) {}

    // When mac.identity is explicitly null (no paid Apple Developer ID available), electron-builder
    // skips code signing entirely. That leaves only the main executable ad-hoc signed (the linker's
    // automatic arm64 stub signature) while bundled Electron frameworks — Electron Framework,
    // Squirrel.framework (the native macOS auto-update engine electron-updater relies on),
    // ReactiveObjC, Mantle — keep whatever signature they shipped with. AMFI rejects that
    // inconsistency at launch: `log show` on a real launch attempt showed
    // "AMFI: '.../Electron Framework' has no CMS blob?" / "Unrecoverable CT signature issue,
    // bailing out." for each of those frameworks, and the app never got a PID.
    // Deep ad-hoc signing the whole bundle after packaging makes every nested binary's signature
    // state consistent, which AMFI accepts for local/unnotarized execution (still requires the
    // user to right-click → Open / allow in System Settings the first time, same as any
    // unsigned app — this does not equal or replace a real Developer ID signature).
    const identity = context.packager.config?.mac?.identity;
    if (context.electronPlatformName === 'darwin' && identity === null) {
        try {
            execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });
            console.log('  • afterPack: deep ad-hoc signed entire bundle (no paid Developer ID configured)');
        } catch (e) {
            console.warn('  • afterPack: deep ad-hoc signing failed:', e.message);
        }
    }
};
