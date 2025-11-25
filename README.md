# @rgon/pulseaudio_js 🔈

> [!NOTE]
> This projet is a fork of the well-built [tmigone/pulseaudio](https://github.com/tmigone/pulseaudio) to add modern (non-deprecated) node.js support, approve unattended PRs and add GJS compatibility.

A TypeScript client library for [PulseAudio](https://www.freedesktop.org/wiki/Software/PulseAudio/), compatible with [PipeWire-pulse](https://docs.pipewire.org/page_man_pipewire-pulse_1.html). Allows you to easily build clients or applications that interact with its server: media players/recorders, volume control applications, etc.


### Features
- GJS Compatibility to run on GNOME extensions or other GJS applications `(NOTE: use vite or another bundler to bundle this dependency on GJS projects, since they don't have npm module resolution)`.
- Fully typed TypeScript implementation of the PulseAudio client protocol
- Extensive testing suite
- Protocol features:
  - authentication - provide authentication data for the server
  - transport - connect over UNIX domain sockets or TCP sockets
  - introspection - query, modify and operate on PulseAudio objects like modules, sinks, sources, etc.
  - events - subscribe to server-side object events like a sink starting playback, etc.
  - (To be implemented) streams - manage audio playback and recording using Node.js streams

## Installation

Install the library using [npm](https://www.npmjs.com/):
```bash
pnpm add git+https://github.com/rgon/pulseaudio_js.git#v2.0.3
```

## Usage

```ts
import PulseAudio, { Sink } from '@rgon/pulseaudio_js'

(async () => {
  // Connect using tcp or unix socket
  // const client: PulseAudio = new PulseAudio('unix:/run/pulse/pulseaudio.socket')
  const client: PulseAudio = new PulseAudio('tcp:192.168.1.10:4317')
  await client.connect()

  // Set volume of all sinks to 50%
  const sinks: Sink[] = await client.getSinkList()
  for (const sink of sinks) {
    await client.setSinkVolume(sink.index, 50)
  }

  // Close connection
  client.disconnect()
})()
```

## Documentation

Visit the parent project's [docs site](http://pulseaudio.tmigone.com) for in depth documentation on the library API's.