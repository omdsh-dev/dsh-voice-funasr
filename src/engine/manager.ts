/**
 * FunASR engine sidecar manager.
 *
 * Owns the Python engine subprocess (stdio line-JSON protocol, see
 * python/funasr_engine.py): spawn/lazy respawn, boot handshake, serialized
 * request/response correlation, per-request timeouts, and disposal. Audio
 * bytes never touch disk on the host side — base64 PCM goes straight into
 * the engine's stdin and the engine deletes its temporary WAVs immediately.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import { existsSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import path from 'node:path'

export interface ManagerOptions {
  /** Interpreter commands to try in order (default ['python3', 'python']). */
  pythonCommands: string[]
  /** Root dir containing paraformer/vad/punc model subdirs. */
  modelRoot: string
  /** onnxruntime intra-op threads. */
  threads: number
}

export type EngineProcessState = 'stopped' | 'starting' | 'running' | 'crashed'

export interface PythonStatus {
  command: string
  found: boolean
  version?: string
  error?: string
}

export interface EngineStatus {
  python: PythonStatus
  process: EngineProcessState
  modelRoot: string
  missing?: string[]
  models?: Record<string, { ready: boolean; loaded: boolean; dir: string }>
  requestsTotal?: number
  lastError?: string
}

export interface TranscribeResult {
  text: string
  rawText: string
  durationS: number
  elapsedMs: number
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export class EngineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message)
    this.name = 'EngineError'
  }
}

const REQUEST_TIMEOUT_MS = 120_000
const SPAWN_COOLDOWN_WINDOW_MS = 60_000
const SPAWN_COOLDOWN_MAX = 4
const LINE_BUFFER_MAX_BYTES = 64 * 1024 * 1024

export function defaultModelRoot(): string {
  return path.join(os.homedir(), '.dsh', 'voice-funasr', 'models')
}

export function engineScriptPath(): string {
  // tsc compiles this file to lib/engine/manager.js (the src tree is kept;
  // tsdown only bundles the client half), so the package root is two levels
  // up. The old '../python' resolved from lib/engine/manager.js to a
  // nonexistent lib/python directory, making the spawn cwd invalid and the
  // engine fail with ENOENT on every launch.
  return fileURLToPath(new URL('../../python/funasr_engine.py', import.meta.url))
}

export class EngineManager {
  private handle: SubprocessHandle | undefined
  private state: EngineProcessState = 'stopped'
  private boot: { ok: boolean; missing?: string[]; modelRoot?: string } | undefined
  private statusCache: EngineStatus | undefined
  private pending = new Map<number, PendingRequest>()
  private nextId = 1
  private queue: Promise<void> = Promise.resolve()
  private lineBuffer = ''
  private spawnTimes: number[] = []
  private lastError: string | undefined
  private disposed = false
  private pythonStatus: PythonStatus | undefined
  private currentBootResolve: ((value: unknown) => void) | undefined
  private currentBootReject: ((error: Error) => void) | undefined

  constructor(
    private readonly ctx: Context,
    private readonly options: ManagerOptions,
  ) {}

  /* ── lifecycle ─────────────────────────────────────────────────────── */

  /**
   * Startup probe: report environment readiness to the log only. Never
   * spawns the engine — processes start lazily on the first endpoint request
   * (spawning at plugin load turned a transient spawn failure into a fatal
   * host crash in testing).
   */
  async start(): Promise<void> {
    if (this.disposed) return
    try {
      const status = await this.status()
      if (!status.python.found) {
        this.ctx.logger('dsh-voice-funasr').warn(`python interpreter not found (tried: ${this.options.pythonCommands.join(', ')}); voice input falls back to the Web Speech API`)
      } else if (status.missing !== undefined && status.missing.length > 0) {
        this.ctx.logger('dsh-voice-funasr').warn(`FunASR models missing: ${status.missing.join(', ')} (expected under ${this.options.modelRoot})`)
      } else {
        this.ctx.logger('dsh-voice-funasr').info('FunASR engine ready; /asr/transcribe available')
      }
    } catch {
      // probes are informational only
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new EngineError('engine-stopped', 'engine disposed'))
    }
    this.pending.clear()
    const handle = this.handle
    this.handle = undefined
    if (handle === undefined) return
    try {
      if (handle.stdin !== undefined) handle.stdin.write('{"action":"exit","id":-1}\n')
    } catch {
      // ignore write errors on a dying pipe
    }
    const exited = await handle.waitForExit()
    if (!exited) handle.terminate()
  }

  /* ── python detection ─────────────────────────────────────────────── */

  async detectPython(): Promise<PythonStatus> {
    if (this.pythonStatus !== undefined) return this.pythonStatus
    // On Windows 'python3' frequently does not exist while 'python' does;
    // try every candidate in order until one answers --version with exit 0.
    for (const command of this.options.pythonCommands) {
      const result = await this.tryInterpreter(command)
      if (result.found) {
        this.pythonStatus = result
        return result
      }
    }
    this.pythonStatus = {
      command: this.options.pythonCommands.join(' / '),
      found: false,
      error: 'no python interpreter found; install python3 and add it to PATH',
    }
    return this.pythonStatus
  }

  private async tryInterpreter(command: string): Promise<PythonStatus> {
    try {
      const handle = this.ctx.subprocess.spawn({
        argv: [command, '--version'],
        cwd: os.tmpdir(),
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 3000,
      })
      const outcome = await handle.done
      const out = handle.collected.stdout?.readFrom(0).text.trim() ?? ''
      const err = handle.collected.stderr?.readFrom(0).text.trim() ?? ''
      return {
        command,
        found: outcome.exitCode === 0,
        version: out || err || undefined,
      }
    } catch (error) {
      return {
        command,
        found: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /* ── status ───────────────────────────────────────────────────────── */

  async status(): Promise<EngineStatus> {
    const python = await this.detectPython()
    const status: EngineStatus = {
      python,
      process: this.state,
      modelRoot: this.options.modelRoot,
      lastError: this.lastError,
    }
    if (this.boot !== undefined) status.missing = this.boot.missing
    if (this.statusCache !== undefined) {
      status.models = this.statusCache.models
      status.requestsTotal = this.statusCache.requestsTotal
    }
    if (this.state === 'stopped' && python.found) {
      // cheap local dir probe so the settings panel can guide installation
      // even before the engine ever spawns
      const dirs = ['paraformer', 'vad', 'punc']
      const ready: Record<string, boolean> = {}
      const missing: string[] = []
      for (const name of dirs) {
        const dir = path.join(this.options.modelRoot, name)
        let has = false
        try {
          has = existsSync(dir) && readdirSync(dir).some(f => f.endsWith('.onnx'))
        } catch {
          has = false
        }
        ready[name] = has
        if (!has) missing.push(name)
      }
      status.models = Object.fromEntries(
        dirs.map(name => [name, { ready: ready[name] ?? false, loaded: false, dir: path.join(this.options.modelRoot, name) }]),
      )
      if (missing.length > 0) status.missing = missing
    }
    return status
  }

  /* ── RPC entry points ─────────────────────────────────────────────── */

  /** Transcribe one PCM16 base64 buffer; spawns the engine on first use. */
  async transcribe(input: { pcm16Base64: string; sampleRate?: number; vad?: boolean; punc?: boolean }): Promise<TranscribeResult> {
    const result = await this.request('transcribe', {
      audio: {
        pcm16_base64: input.pcm16Base64,
        sample_rate: input.sampleRate ?? 16000,
      },
      vad: input.vad ?? true,
      punc: input.punc ?? true,
    })
    if (!isRecord(result) || typeof result.text !== 'string') {
      throw new EngineError('engine-response', 'engine returned an invalid transcribe result')
    }
    return {
      text: result.text,
      rawText: typeof result.raw_text === 'string' ? result.raw_text : result.text,
      durationS: typeof result.duration_s === 'number' ? result.duration_s : 0,
      elapsedMs: typeof result.elapsed_ms === 'number' ? result.elapsed_ms : 0,
    }
  }

  /** Load all present models (idempotent); used by the settings panel. */
  async warmup(): Promise<Record<string, unknown>> {
    const result = await this.request('warmup', {})
    if (!isRecord(result)) throw new EngineError('engine-response', 'engine returned an invalid warmup result')
    return result
  }

  /* ── subprocess plumbing ──────────────────────────────────────────── */

  private async request(action: string, payload: Record<string, unknown>): Promise<unknown> {
    const run = async (): Promise<unknown> => {
      await this.ensureRunning()
      const handle = this.handle
      if (handle === undefined || handle.stdin === undefined) {
        throw new EngineError('engine-unavailable', 'engine process is not running')
      }
      const stdin = handle.stdin
      const id = this.nextId++
      return await new Promise<unknown>((resolve, reject) => {
        this.pending.set(id, {
          resolve,
          reject,
          timer: setTimeout(() => {
            this.pending.delete(id)
            reject(new EngineError('engine-timeout', `engine request ${action} timed out`))
          }, REQUEST_TIMEOUT_MS),
        })
        try {
          stdin.write(`${JSON.stringify({ action, id, ...payload })}\n`)
        } catch (error) {
          const pending = this.pending.get(id)
          if (pending !== undefined) {
            clearTimeout(pending.timer)
            this.pending.delete(id)
          }
          reject(error)
        }
      })
    }
    const promise = this.queue.then(run, run)
    this.queue = promise.then(() => {}, () => {})
    return promise
  }

  private async ensureRunning(): Promise<void> {
    if (this.disposed) throw new EngineError('engine-stopped', 'manager disposed')
    if (this.state === 'running' || this.state === 'starting') return
    const python = await this.detectPython()
    if (!python.found) {
      throw new EngineError('engine-python-missing', `python interpreter not found (tried: ${this.options.pythonCommands.join(', ')})`)
    }
    const now = Date.now()
    this.spawnTimes = this.spawnTimes.filter(t => now - t < SPAWN_COOLDOWN_WINDOW_MS)
    if (this.spawnTimes.length >= SPAWN_COOLDOWN_MAX) {
      throw new EngineError('engine-unavailable', 'engine crashed repeatedly; check the log or restart DSH')
    }
    this.spawnTimes.push(now)
    this.state = 'starting'
    this.lastError = undefined
    this.boot = undefined
    this.statusCache = undefined
    let bootResolve!: (value: unknown) => void
    let bootReject!: (error: Error) => void
    const bootOnce = new Promise<unknown>((resolve, reject) => {
      bootResolve = resolve
      bootReject = reject
    })
    this.currentBootResolve = bootResolve
    this.currentBootReject = bootReject

    let handle: SubprocessHandle
    try {
      handle = this.ctx.subprocess.spawn({
        argv: [
          python.command,
          engineScriptPath(),
          '--model-root', this.options.modelRoot,
          '--threads', String(this.options.threads),
        ],
        cwd: path.dirname(engineScriptPath()),
        stdio: {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: { maxBytes: 256 * 1024 },
        },
        graceMs: 3000,
      })
    } catch (error) {
      this.state = 'crashed'
      this.lastError = error instanceof Error ? error.message : String(error)
      this.currentBootResolve = undefined
      this.currentBootReject = undefined
      throw new EngineError('engine-spawn', `failed to spawn engine: ${this.lastError}`)
    }

    this.handle = handle
    this.lineBuffer = ''
    const stdout = handle.stdout
    if (stdout === undefined) {
      this.state = 'crashed'
      this.lastError = 'engine stdout pipe missing'
      this.currentBootResolve = undefined
      this.currentBootReject = undefined
      handle.terminate()
      throw new EngineError('engine-spawn', this.lastError)
    }

    stdout.on('data', (chunk: Buffer) => {
      this.lineBuffer += chunk.toString('utf8')
      if (this.lineBuffer.length > LINE_BUFFER_MAX_BYTES) {
        this.lineBuffer = ''
        return
      }
      let newline: number
      while ((newline = this.lineBuffer.indexOf('\n')) !== -1) {
        const line = this.lineBuffer.slice(0, newline)
        this.lineBuffer = this.lineBuffer.slice(newline + 1)
        this.onLine(line)
      }
    })

    void handle.done.then(
      outcome => {
        if (this.handle !== handle) return
        this.handle = undefined
        this.currentBootResolve = undefined
        this.currentBootReject = undefined
        if (!this.disposed) {
          this.state = 'crashed'
          this.lastError = `engine exited unexpectedly (code ${outcome.exitCode ?? 'null'})`
          const stderrText = handle.collected.stderr?.readFrom(0).text ?? ''
          if (stderrText !== '') this.lastError += ` — ${stderrText.slice(-400)}`
          for (const entry of this.pending.values()) {
            clearTimeout(entry.timer)
            entry.reject(new EngineError('engine-crashed', this.lastError))
          }
          this.pending.clear()
        }
      },
      error => {
        // done rejects only for spawn-level failures; never let this escape
        // as an unhandled rejection (a host crash in earlier testing).
        if (this.handle !== handle) return
        this.handle = undefined
        this.currentBootResolve = undefined
        const bootRejectNow = this.currentBootReject
        this.currentBootReject = undefined
        this.state = 'crashed'
        this.lastError = `engine spawn failed: ${error instanceof Error ? error.message : String(error)}`
        bootRejectNow?.(new EngineError('engine-spawn', this.lastError))
        for (const entry of this.pending.values()) {
          clearTimeout(entry.timer)
          entry.reject(new EngineError('engine-crashed', this.lastError))
        }
        this.pending.clear()
      },
    )

    await this.waitForBoot(bootOnce)
    this.state = 'running'
  }

  private async waitForBoot(bootOnce: Promise<unknown>): Promise<void> {
    const boot = await Promise.race([
      bootOnce,
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new EngineError('engine-timeout', 'engine boot handshake timed out')), 30_000)
      }),
    ])
    if (!isRecord(boot)) throw new EngineError('engine-spawn', 'engine boot line was not an object')
    if (boot.ok !== true) {
      const missing = Array.isArray(boot.missing) ? boot.missing : []
      throw new EngineError('engine-models-missing', `models missing: ${missing.join(', ') || 'unknown'}`)
    }
  }

  private onLine(line: string): void {
    if (line.trim() === '') return
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      this.lastError = `engine emitted a non-JSON line: ${line.slice(0, 200)}`
      return
    }
    if (!isRecord(parsed)) return

    if (parsed.type === 'boot') {
      this.boot = {
        ok: parsed.ok === true,
        missing: Array.isArray(parsed.missing) ? parsed.missing : undefined,
        modelRoot: typeof parsed.model_root === 'string' ? parsed.model_root : undefined,
      }
      this.currentBootResolve?.(parsed)
      this.currentBootResolve = undefined
      return
    }

    const id = typeof parsed.id === 'number' ? parsed.id : undefined
    if (id === undefined) {
      // engine async notice (none currently) — log and continue
      this.lastError = `engine emitted an unknown line: ${line.slice(0, 200)}`
      return
    }
    const pending = this.pending.get(id)
    if (pending === undefined) return
    clearTimeout(pending.timer)
    this.pending.delete(id)

    if (parsed.ok === false) {
      pending.reject(new EngineError('engine-error', typeof parsed.error === 'string' ? parsed.error : 'engine request failed'))
      return
    }
    if (parsed.action === undefined && parsed.models !== undefined) {
      this.statusCache = {
        models: parsed.models as EngineStatus['models'],
        requestsTotal: typeof parsed.requests_total === 'number' ? parsed.requests_total : undefined,
      } as EngineStatus
    }
    pending.resolve(parsed)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
