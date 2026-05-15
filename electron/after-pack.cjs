/**
 * electron-builder hook: re-sign bundled Python after it is copied into the .app.
 * install_name_tool / strip during prepare-bundle invalidate signatures; signing must
 * run again on the final Resources/python tree.
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const pythonDir = path.join(context.appOutDir, 'Contents', 'Resources', 'python')
  if (!fs.existsSync(pythonDir)) {
    console.warn('[afterPack] Resources/python not found, skipping sign')
    return
  }

  const script = path.join(__dirname, '..', 'scripts', 'sign-bundle-python.sh')
  console.log('[afterPack] Signing bundled Python at', pythonDir)
  execFileSync('bash', [script, pythonDir], { stdio: 'inherit' })
}
