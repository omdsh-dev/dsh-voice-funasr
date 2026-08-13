import { mkdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_PATHS = new Map([
  ['@deepseek-ai/cordis', 'vendor/cordis'],
  ['@deepseek-ai/dsh-agent-default-model', 'packages/core/agent-default-model'],
  ['@deepseek-ai/dsh-client-connection', 'packages/client/connection'],
  ['@deepseek-ai/dsh-client-locale', 'packages/client/locale'],
  ['@deepseek-ai/dsh-client-runtime', 'packages/client/runtime'],
  ['@deepseek-ai/dsh-client-ui-conversation', 'packages/client/ui-conversation'],
  ['@deepseek-ai/dsh-client-ui-settings', 'packages/client/ui-settings'],
  ['@deepseek-ai/dsh-client-ui-slots', 'packages/client/ui-slots'],
  ['@deepseek-ai/dsh-llm', 'packages/llm/llm'],
  ['@deepseek-ai/dsh-subprocess', 'packages/subprocess/subprocess'],
  ['@deepseek-ai/schemastery', 'vendor/schemastery'],
])

const rawArgv = process.argv.slice(2)
const argv = rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv
const sourceIndex = argv.indexOf('--source')
const runtimeIndex = argv.indexOf('--runtime')
if ((sourceIndex === -1) === (runtimeIndex === -1) || argv.length !== 2) {
  throw new Error('usage: pnpm run dev:link-dsh -- --runtime /absolute/path/to/node_modules (or --source /absolute/path/to/dsh-source)')
}

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = sourceIndex === -1 ? undefined : await realpath(resolve(argv[sourceIndex + 1]))
const runtimeRoot = runtimeIndex === -1 ? undefined : await realpath(resolve(argv[runtimeIndex + 1]))
const rootManifest = await readManifest(sourceRoot === undefined
  ? join(runtimeRoot, '@deepseek-ai/dsh/package.json')
  : join(sourceRoot, 'package.json'))
if (!isCompatibleDshVersion(rootManifest.version)) {
  throw new Error(`DSH must satisfy >=0.1.0-rc.3 <0.2.0; found ${String(rootManifest.version)}`)
}

for (const [expectedName, packagePath] of PACKAGE_PATHS) {
  const packageRoot = await realpath(sourceRoot === undefined
    ? join(runtimeRoot, ...expectedName.split('/'))
    : join(sourceRoot, packagePath))
  const manifest = await readManifest(join(packageRoot, 'package.json'))
  if (manifest.name !== expectedName) {
    throw new Error(`${packagePath}/package.json names ${String(manifest.name)}; expected ${expectedName}`)
  }
  const target = join(repositoryRoot, 'node_modules', ...expectedName.split('/'))
  await mkdir(dirname(target), { recursive: true })
  await rm(target, { recursive: true, force: true })
  await symlink(packageRoot, target, 'dir')
  process.stdout.write(`linked ${expectedName} -> ${packageRoot}\n`)
}

async function readManifest(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

function isCompatibleDshVersion(version) {
  const match = /^0\.1\.(\d+)(?:-rc\.(\d+))?$/.exec(String(version))
  if (match === null) return false
  const patch = Number(match[1])
  return patch > 0 || match[2] === undefined || Number(match[2]) >= 3
}
