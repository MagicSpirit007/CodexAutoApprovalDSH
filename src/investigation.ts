import type { FileSystem } from '@deepseek-ai/dsh-fs'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import type { Config } from './config.js'

/** Private capability allowlist: these functions never dispatch arbitrary host tools. */
export const investigationSchemas: ToolSchema[] = [
  { name: 'review_stat_path', description: 'Inspect whether a local path exists and its metadata, without changing it.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'review_list_directory', description: 'List bounded direct directory entries without reading their contents.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'review_read_file', description: 'Read one bounded UTF-8 byte window from a regular local file. Git metadata can be inspected with this tool. No commands are executed.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1 } }, required: ['path'], additionalProperties: false } },
]

export async function investigate(fs: FileSystem, name: string, raw: string, cwd: string,
  signal: AbortSignal, config: Config): Promise<string> {
  signal.throwIfAborted()
  if (!investigationSchemas.some(schema => schema.name === name)) throw new Error('Unknown investigation capability')
  const args: Record<string, unknown> = JSON.parse(raw || '{}')
  if (!args || Array.isArray(args) || typeof args.path !== 'string' || !args.path.length
    || Object.keys(args).some(key => !(name === 'review_read_file' ? ['path', 'offset', 'length'] : ['path']).includes(key))) {
    throw new Error('Invalid investigation arguments')
  }
  const target = await fs.resolve(args.path, { cwd, signal })
  if (name === 'review_stat_path') {
    const info = await fs.stat(target, signal)
    return JSON.stringify({ path: target.displayPath, exists: info !== undefined, info })
  }
  if (name === 'review_list_directory') {
    const entries = await fs.listDir(target, signal)
    const listed = entries.slice(0, config.maxDirectoryEntries).map(entry => ({
      ...entry, target: undefined,
    }))
    return JSON.stringify({ path: target.displayPath, entries: listed, omittedEntries: entries.length - listed.length })
  }
  const offset = args.offset ?? 0, length = args.length ?? config.maxReadBytes
  if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(length)
    || (length as number) < 1 || (length as number) > config.maxReadBytes) throw new Error('Invalid or excessive byte window')
  const info = await fs.stat(target, signal)
  const data = await fs.readByteRange(target, { offset: offset as number, length: length as number }, signal)
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data)
  if (text.includes('\0')) throw new Error('Binary content is not available to the reviewer')
  return JSON.stringify({ path: target.displayPath, offset, bytesRead: data.byteLength, info, text,
    nextOffset: (offset as number) + data.byteLength,
    windowNotice: 'This is a byte window; omitted bytes are unknown. Read further windows when necessary.' })
}
