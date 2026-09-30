import { cp } from 'node:fs/promises'
await cp(new URL('../src/policies/', import.meta.url), new URL('../lib/policies/', import.meta.url), { recursive: true })
