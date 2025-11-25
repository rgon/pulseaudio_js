export type BufferEncoding = 'utf8' | 'utf16le' | 'latin1' | 'base64' | 'hex'

type RequireFn = (id: string) => unknown
declare const require: RequireFn | undefined

interface GLibDir {
  read_name: () => string | null
  close: () => void
}

interface GLibDirConstructor {
  open: (path: string, flags: number) => GLibDir
}

interface GLibModule {
  file_get_contents: (path: string) => [boolean, unknown]
  file_set_contents: (path: string, data: Uint8Array | string) => boolean
  Dir: GLibDirConstructor
  base64_encode?: (data: Uint8Array) => string
}

interface ByteArrayModule {
  fromGBytes?: (bytes: unknown) => Uint8Array
}

interface ImportsModule {
  gi?: {
    GLib?: GLibModule
  }
  byteArray?: ByteArrayModule
}

declare const imports: ImportsModule | undefined

type NodeFsModule = typeof import('fs')

let cachedFs: NodeFsModule | null | undefined

function getNodeFs (): NodeFsModule | null {
  if (cachedFs !== undefined) {
    return cachedFs
  }

  cachedFs = null

  if (typeof require === 'function') {
    try {
      const fsModule = require('fs') as NodeFsModule | undefined
      if (fsModule !== undefined && typeof fsModule.readFileSync === 'function') {
        cachedFs = fsModule
      }
    } catch (_error) {
      cachedFs = null
    }
  }

  return cachedFs
}

function getGLib (): GLibModule {
  if (typeof imports === 'undefined' || imports === null) {
    throw new Error('GLib is not available in this environment.')
  }

  const giNamespace = imports.gi
  if (typeof giNamespace === 'undefined' || giNamespace === null) {
    throw new Error('GLib is not available in this environment.')
  }

  const GLib = giNamespace.GLib
  if (typeof GLib === 'undefined' || GLib === null) {
    throw new Error('GLib is not available in this environment.')
  }

  return GLib
}

function getByteArrayModule (): ByteArrayModule | null {
  if (typeof imports === 'undefined' || imports === null) {
    return null
  }

  const byteArrayModule = imports.byteArray
  return typeof byteArrayModule === 'undefined' ? null : byteArrayModule
}

function ensureUint8Array (payload: unknown): Uint8Array {
  if (payload instanceof Uint8Array) {
    return payload
  }

  const byteArray = getByteArrayModule()
  if (byteArray !== null && typeof byteArray.fromGBytes === 'function') {
    return byteArray.fromGBytes(payload)
  }

  if (typeof payload === 'string') {
    return new TextEncoder().encode(payload)
  }

  throw new Error('Unable to convert payload to Uint8Array for GLib interop.')
}

function decodeBytes (data: Uint8Array, encoding: BufferEncoding, GLib: GLibModule): string {
  switch (encoding) {
    case 'utf8':
      return new TextDecoder('utf-8').decode(data)
    case 'utf16le':
      return new TextDecoder('utf-16le').decode(data)
    case 'latin1': {
      let result = ''
      for (let i = 0; i < data.length; i += 1) {
        result += String.fromCharCode(data[i])
      }
      return result
    }
    case 'base64':
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(data).toString('base64')
      }
      if (typeof globalThis.btoa === 'function') {
        const binary = Array.from(data, (byte) => String.fromCharCode(byte)).join('')
        return globalThis.btoa(binary)
      }
      if (typeof GLib.base64_encode === 'function') {
        return GLib.base64_encode(data)
      }
      throw new Error('Base64 encoding not supported in this environment.')
    case 'hex':
      return Array.from(data, (byte) => byte.toString(16).padStart(2, '0')).join('')
    default:
      throw new Error('Unsupported encoding provided.')
  }
}

export function readFileSync (path: string, encoding?: BufferEncoding | undefined): string {
  const nodeFs = getNodeFs()
  const selectedEncoding = encoding ?? 'utf8'

  if (nodeFs !== null) {
    return nodeFs.readFileSync(path, selectedEncoding)
  }

  const GLib = getGLib()
  const [ok, contents] = GLib.file_get_contents(path) as [boolean, unknown]
  if (!ok) {
    throw new Error(`Failed to read file at ${path}`)
  }

  const data = ensureUint8Array(contents)
  return decodeBytes(data, selectedEncoding, GLib)
}

export function writeFileSync (path: string, data: Buffer | string): void {
  const nodeFs = getNodeFs()
  if (nodeFs !== null) {
    nodeFs.writeFileSync(path, data)
    return
  }

  const GLib = getGLib()
  const payload =
        typeof data === 'string'
          ? new TextEncoder().encode(data)
          : ensureUint8Array(data)

  const success = GLib.file_set_contents(path, payload)
  if (!success) {
    throw new Error(`Failed to write file at ${path}`)
  }
}

export function readdirSync (path: string): string[] {
  const nodeFs = getNodeFs()
  if (nodeFs !== null) {
    return nodeFs.readdirSync(path)
  }

  const GLib = getGLib()
  const entries: string[] = []
  let dir: GLibDir | null = null

  try {
    dir = GLib.Dir.open(path, 0)
    let name: string | null = dir.read_name()
    while (name !== null) {
      entries.push(name)
      name = dir.read_name()
    }
  } finally {
    if (dir !== null) {
      dir.close()
    }
  }

  return entries
}
