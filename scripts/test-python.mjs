import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const enginePath = join(repositoryRoot, 'python', 'funasr_engine.py')
const modelRoot = mkdtempSync(join(tmpdir(), 'dsh-voice-funasr-models-'))

try {
  const result = runPython(enginePath, modelRoot)
  if (result.status !== 0) {
    throw new Error(`Python sidecar exited ${String(result.status)}:\n${result.stderr}`)
  }
  const messages = result.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line))
  const [boot, status, exit] = messages
  if (boot?.type !== 'boot' || boot.ok !== true) throw new Error('missing successful boot envelope')
  if (status?.id !== 1 || status.ok !== true || status.engine_version !== '0.1.1') {
    throw new Error('invalid status envelope')
  }
  if (!Array.isArray(status.missing) || status.missing.length !== 3) {
    throw new Error('empty model root must report all three model families missing')
  }
  if (exit?.id !== 2 || exit.ok !== true || exit.message !== 'bye') {
    throw new Error('invalid exit envelope')
  }
  process.stdout.write('Python sidecar boot/status/exit protocol passed\n')
} finally {
  rmSync(modelRoot, { recursive: true, force: true })
}

function runPython(script, models) {
  const input = [
    JSON.stringify({ action: 'status', id: 1 }),
    JSON.stringify({ action: 'exit', id: 2 }),
    '',
  ].join('\n')
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, [script, '--model-root', models], {
      encoding: 'utf8',
      input,
      timeout: 15_000,
    })
    if (result.error?.code === 'ENOENT') continue
    if (result.error !== undefined) throw result.error
    return result
  }
  throw new Error('python3 or python is required for the FunASR sidecar smoke test')
}
