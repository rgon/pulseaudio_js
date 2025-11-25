import { EventEmitter } from 'events'
import { Buffer } from 'buffer'

type RequireFn = (id: string) => unknown
declare const require: RequireFn | undefined

interface ByteArrayModule {
  fromGBytes?: (bytes: unknown) => Uint8Array
}

interface ImportsModule {
  gi?: {
    GLib?: GLibNamespace
    Gio?: unknown
  }
  byteArray?: ByteArrayModule
}

declare const imports: ImportsModule | undefined

type NodeNetModule = typeof import('net')
type NodeSocketConstructor = typeof import('net').Socket
type NodeSocketInstance = import('net').Socket

let cachedNet: NodeNetModule | null | undefined

function getNodeNet (): NodeNetModule | null {
  if (cachedNet !== undefined) {
    return cachedNet
  }

  cachedNet = null

  if (typeof require === 'function') {
    try {
      const netModule = require('net') as NodeNetModule | undefined
      if (netModule !== undefined && typeof netModule.Socket === 'function') {
        cachedNet = netModule
      }
    } catch (_error) {
      cachedNet = null
    }
  }

  return cachedNet
}

interface GLibNamespace {
  PRIORITY_DEFAULT: number
}

interface GioNamespace {
  SocketClient: new () => GioSocketClient
}

type GioCancellable = unknown

type GioAsyncResult = unknown

type GioSocketClientCallback = (client: GioSocketClient, result: GioAsyncResult) => void

interface GioSocketClient {
  connect_to_uri_async: (uri: string, default_port: number, cancellable: GioCancellable | null, callback: GioSocketClientCallback, user_data: unknown) => void
  connect_to_uri_finish: (result: GioAsyncResult) => GioSocketConnection
}

interface GioSocketConnection {
  get_input_stream: () => GioInputStream | null
  get_output_stream: () => GioOutputStream | null
  close: (cancellable: GioCancellable | null) => boolean
}

type GioInputStreamCallback = (stream: GioInputStream, result: GioAsyncResult) => void

interface GioInputStream {
  read_bytes_async: (count: number, priority: number, cancellable: GioCancellable | null, callback: GioInputStreamCallback) => void
  read_bytes_finish: (result: GioAsyncResult) => GioBytes | null
  close: (cancellable: GioCancellable | null) => boolean
}

interface GioOutputStream {
  write_all: (buffer: Uint8Array, cancellable: GioCancellable | null) => [boolean, number]
  close: (cancellable: GioCancellable | null) => boolean
}

interface GioBytes {
  toArray?: () => Uint8Array | number[]
  get_data?: () => Uint8Array | number[]
  get_size?: () => number
}

function getGjsModules (): { glib: GLibNamespace, gio: GioNamespace, byteArray: ByteArrayModule | null } {
  if (typeof imports === 'undefined' || imports === null) {
    throw new Error('GJS imports are not available in this environment.')
  }

  const giNamespace = imports.gi
  if (typeof giNamespace === 'undefined' || giNamespace === null) {
    throw new Error('GJS GI namespace is not available in this environment.')
  }

  const glibNamespace = giNamespace.GLib
  if (typeof glibNamespace === 'undefined' || glibNamespace === null) {
    throw new Error('GLib is not available in this environment.')
  }

  const gioNamespace = giNamespace.Gio
  if (typeof gioNamespace === 'undefined' || gioNamespace === null) {
    throw new Error('Gio is not available in this environment.')
  }

  const byteArrayModule = typeof imports.byteArray === 'undefined' ? null : imports.byteArray ?? null

  return {
    glib: glibNamespace as unknown as GLibNamespace,
    gio: gioNamespace as unknown as GioNamespace,
    byteArray: byteArrayModule
  }
}

function toError (value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

function bytesToUint8Array (bytes: GioBytes, byteArrayModule: ByteArrayModule | null): Uint8Array {
  if (typeof bytes.toArray === 'function') {
    const result = bytes.toArray()
    if (result instanceof Uint8Array) {
      return result
    }
    return Uint8Array.from(result)
  }

  if (byteArrayModule !== null && typeof byteArrayModule.fromGBytes === 'function') {
    const converted = byteArrayModule.fromGBytes(bytes)
    if (converted instanceof Uint8Array) {
      return converted
    }
    return Uint8Array.from(converted)
  }

  if (typeof bytes.get_data === 'function') {
    const data = bytes.get_data()
    if (data instanceof Uint8Array) {
      return data
    }
    return Uint8Array.from(data)
  }

  if (typeof bytes.get_size === 'function' && bytes.get_size() === 0) {
    return new Uint8Array()
  }

  throw new Error('Unable to convert Gio.Bytes to Uint8Array.')
}

// Minimal Socket polyfill for environments without the Node.js `net` module.
class GjsSocket extends EventEmitter {
  private readonly socketClient: GioSocketClient
  private connection: GioSocketConnection | null = null
  private inputStream: GioInputStream | null = null
  private outputStream: GioOutputStream | null = null
  private readonly byteArrayModule: ByteArrayModule | null
  private readonly gioPriority: number
  private readonly buffers: Buffer[] = []
  private bufferedLength: number = 0
  private readPending: boolean = false
  private closed: boolean = false
  private readonly chunkSize: number = 4096

  public connecting: boolean = false
  public destroyed: boolean = false

  constructor () {
    super()
    const modules = getGjsModules()
    this.socketClient = new modules.gio.SocketClient()
    this.byteArrayModule = modules.byteArray
    this.gioPriority = typeof modules.glib.PRIORITY_DEFAULT === 'number' ? modules.glib.PRIORITY_DEFAULT : 0
  }

  connect (port: number, host?: string): this
  connect (path: string): this
  connect (portOrPath: number | string, host?: string): this {
    if (typeof portOrPath === 'number') {
      const resolvedHost = typeof host === 'string' && host.length > 0 ? host : 'localhost'
      const uri = `tcp:${resolvedHost}:${portOrPath}`
      this.beginConnection(uri)
      return this
    }

    const target = portOrPath
    if (target.startsWith('tcp:')) {
      const withoutScheme = target.substring(4)
      const parts = withoutScheme.split(':')
      const resolvedHost = parts[0] !== undefined && parts[0].length > 0 ? parts[0] : 'localhost'
      const portString = parts[1]
      const portValue = portString !== undefined ? Number.parseInt(portString, 10) : Number.NaN
      if (Number.isNaN(portValue)) {
        this.emit('error', new Error('Invalid TCP address.'))
        return this
      }
      const uri = `tcp:${resolvedHost}:${portValue}`
      this.beginConnection(uri)
      return this
    }

    const normalizedPath = target.startsWith('unix:') ? target.substring(5) : target
    const uri = `unix:${normalizedPath}`
    this.beginConnection(uri)
    return this
  }

  write (data: Buffer | Uint8Array | string): boolean {
    if (this.outputStream === null) {
      this.emit('error', new Error('Socket is not connected.'))
      return false
    }

    let payload: Buffer
    if (typeof data === 'string') {
      payload = Buffer.from(data)
    } else if (Buffer.isBuffer(data)) {
      payload = data
    } else {
      payload = Buffer.from(data)
    }

    const chunk = Uint8Array.from(payload)

    try {
      const [ok] = this.outputStream.write_all(chunk, null)
      if (!ok) {
        this.emit('error', new Error('Unable to write to socket.'))
        return false
      }
    } catch (error) {
      this.emit('error', toError(error))
      return false
    }

    return true
  }

  read (size?: number): Buffer {
    const available = this.bufferedLength
    if (available === 0) {
      return Buffer.alloc(0)
    }

    const targetSize = size !== undefined ? Math.min(size, available) : available
    const result = Buffer.allocUnsafe(targetSize)
    let offset = 0

    while (offset < targetSize && this.buffers.length > 0) {
      const chunk = this.buffers[0]
      const remaining = targetSize - offset
      if (chunk.length <= remaining) {
        chunk.copy(result, offset)
        offset += chunk.length
        this.buffers.shift()
      } else {
        chunk.copy(result, offset, 0, remaining)
        this.buffers[0] = chunk.subarray(remaining)
        offset += remaining
      }
    }

    this.bufferedLength -= targetSize
    return result
  }

  end (): this {
    if (!this.closed) {
      this.closed = true
      this.destroyed = true
      this.cleanupStreams()
      this.emit('close')
    }

    return this
  }

  destroy (error?: unknown): this {
    if (error !== undefined) {
      this.emit('error', toError(error))
    }
    return this.end()
  }

  get readableLength (): number {
    return this.bufferedLength
  }

  private beginConnection (uri: string): void {
    this.connecting = true
    this.closed = false
    this.destroyed = false

    // Extract default_port from URI if possible, otherwise use 0
    let defaultPort = 0
    const match = uri.match(/^tcp:[^:]+:(\d+)$/)
    if (match != null) {
      defaultPort = parseInt(match[1], 10)
    }

    this.socketClient.connect_to_uri_async(
      uri,
      defaultPort,
      null,
      (client, result) => {
        try {
          const connection = client.connect_to_uri_finish(result)
          this.onConnected(connection)
        } catch (error) {
          this.connecting = false
          this.emit('error', toError(error))
        }
      },
      null // user_data
    )
  }

  private onConnected (connection: GioSocketConnection): void {
    const input = connection.get_input_stream()
    const output = connection.get_output_stream()

    if (input === null || output === null) {
      this.connecting = false
      this.emit('error', new Error('Unable to access socket streams.'))
      return
    }

    this.connection = connection
    this.inputStream = input
    this.outputStream = output
    this.connecting = false
    this.closed = false
    this.destroyed = false

    this.queueRead()
    this.emit('connect')
  }

  private queueRead (): void {
    if (this.inputStream === null || this.closed || this.readPending) {
      return
    }

    this.readPending = true
    this.inputStream.read_bytes_async(this.chunkSize, this.gioPriority, null, (stream, result) => {
      this.readPending = false
      try {
        const bytes = stream.read_bytes_finish(result)
        if (bytes === null) {
          this.handleRemoteClose()
          return
        }

        const data = bytesToUint8Array(bytes, this.byteArrayModule)
        if (data.length === 0) {
          this.handleRemoteClose()
          return
        }

        const buffer = Buffer.from(data)
        this.buffers.push(buffer)
        this.bufferedLength += buffer.length
        this.emit('readable')

        if (!this.closed) {
          this.queueRead()
        }
      } catch (error) {
        this.emit('error', toError(error))
      }
    })
  }

  private handleRemoteClose (): void {
    if (this.closed) {
      return
    }

    this.closed = true
    this.cleanupStreams()
    this.destroyed = true
    this.emit('end')
    this.emit('close')
  }

  private cleanupStreams (): void {
    if (this.inputStream !== null) {
      try {
        this.inputStream.close(null)
      } catch (_error) {
        // ignore close errors
      }
      this.inputStream = null
    }

    if (this.outputStream !== null) {
      try {
        this.outputStream.close(null)
      } catch (_error) {
        // ignore close errors
      }
      this.outputStream = null
    }

    if (this.connection !== null) {
      try {
        this.connection.close(null)
      } catch (_error) {
        // ignore close errors
      }
      this.connection = null
    }

    this.readPending = false
    this.connecting = false
  }
}

const nodeNet = getNodeNet()

const SocketImpl: NodeSocketConstructor = nodeNet !== null
  ? nodeNet.Socket
  : (GjsSocket as unknown as NodeSocketConstructor)

export { SocketImpl as Socket }
export type Socket = NodeSocketInstance
