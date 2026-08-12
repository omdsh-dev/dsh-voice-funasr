/**
 * 16kHz mono PCM16 capture via AudioWorklet.
 *
 * The browser hands us Float32 blocks at the AudioContext rate; we resample
 * by constructing the context at 16000 Hz directly (Chrome/Edge/Firefox
 * honor the sampleRate hint; Safari may not, in which case the engine gets
 * the actual rate in the payload and FunASR resamples internally).
 *
 * Falls back to unavailable when AudioWorklet is missing (very old
 * browsers) — the recognizer factory then selects the Web Speech backend.
 */

export interface Pcm16Capture {
  readonly sampleRate: number
  start(): Promise<void>
  /** Stop capture and return the whole utterance as base64 PCM16 little-endian. */
  stop(): Promise<{ pcm16Base64: string; sampleRate: number; durationS: number }>
  dispose(): void
}

export function isCaptureSupported(): boolean {
  return typeof window !== 'undefined'
    && typeof AudioContext !== 'undefined'
    && typeof navigator !== 'undefined'
    && typeof navigator.mediaDevices?.getUserMedia === 'function'
    && typeof AudioWorkletNode !== 'undefined'
}

const WORKLET_SOURCE = `
class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0]
    if (input !== undefined && input[0] !== undefined) {
      this.port.postMessage(input[0])
    }
    return true
  }
}
registerProcessor('pcm16-capture', Pcm16CaptureProcessor)
`

const TARGET_RATE = 16000

export function createPcm16Capture(): Pcm16Capture {
  if (!isCaptureSupported()) {
    return {
      sampleRate: 0,
      start: () => Promise.reject(new Error('AudioWorklet capture unsupported')),
      stop: () => Promise.reject(new Error('AudioWorklet capture unsupported')),
      dispose: () => {},
    }
  }

  let context: AudioContext | undefined
  let stream: MediaStream | undefined
  let node: AudioWorkletNode | undefined
  let chunks: Float32Array[] = []
  let actualRate = TARGET_RATE
  let disposed = false

  return {
    get sampleRate(): number { return actualRate },

    async start(): Promise<void> {
      disposed = false
      chunks = []
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: TARGET_RATE,
        },
      })
      actualRate = stream.getAudioTracks()[0]?.getSettings().sampleRate ?? TARGET_RATE
      context = new AudioContext({ sampleRate: TARGET_RATE })
      const blobUrl = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }))
      try {
        await context.audioWorklet.addModule(blobUrl)
      } finally {
        URL.revokeObjectURL(blobUrl)
      }
      const source = context.createMediaStreamSource(stream)
      node = new AudioWorkletNode(context, 'pcm16-capture', { numberOfInputs: 1, numberOfOutputs: 0 })
      node.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!disposed) chunks.push(event.data)
      }
      source.connect(node)
      await context.resume()
    },

    async stop(): Promise<{ pcm16Base64: string; sampleRate: number; durationS: number }> {
      if (node !== undefined) node.port.close()
      if (context !== undefined) await context.close()
      const all = concatChunks(chunks)
      chunks = []
      for (const track of stream?.getTracks() ?? []) track.stop()
      stream = undefined
      node = undefined
      context = undefined
      const pcm = float32ToPcm16(all)
      const bytes = new Uint8Array(pcm.buffer)
      let binary = ''
      const step = 0x8000
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode(...bytes.subarray(i, i + step))
      }
      return {
        pcm16Base64: btoa(binary),
        sampleRate: actualRate,
        durationS: pcm.length / actualRate,
      }
    },

    dispose(): void {
      disposed = true
      for (const track of stream?.getTracks() ?? []) track.stop()
      if (node !== undefined) node.port.close()
      void context?.close()
      stream = undefined
      node = undefined
      context = undefined
      chunks = []
    },
  }
}

function concatChunks(chunks: Float32Array[]): Float32Array {
  let total = 0
  for (const chunk of chunks) total += chunk.length
  const out = new Float32Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

function float32ToPcm16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const sample = samples[i] ?? 0
    const clamped = Math.max(-1, Math.min(1, sample))
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return out
}
