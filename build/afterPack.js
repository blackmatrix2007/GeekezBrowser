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
};
