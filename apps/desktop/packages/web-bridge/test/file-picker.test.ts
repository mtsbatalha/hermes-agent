import { afterEach, describe, expect, it, vi } from 'vitest'

import { createWebBridge } from '../src/index.ts'

const picker = () =>
  createWebBridge().selectPaths as (options?: { directories?: boolean; profile?: string }) => Promise<string[]>
afterEach(() => vi.unstubAllGlobals())

describe('web file picker', () => {
  it('uploads bytes before returning a gateway path, without overwriting an existing file', async () => {
    vi.stubGlobal('showOpenFilePicker', async () => [
      {
        getFile: async () => ({
          name: 'notes.txt',
          type: 'text/plain',
          arrayBuffer: async () => new TextEncoder().encode('hello').buffer
        })
      }
    ])
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(
        JSON.stringify(url === '/api/files' ? { path: '/managed' } : { path: '/managed/uploads/notes.txt' })
      )
    })
    expect(await picker()({ profile: 'work' })).toEqual(['/managed/uploads/notes.txt'])
    expect(calls[1].url).toBe('/api/files/upload-stream?profile=work')
    const form = calls[1].init.body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect(form.get('path')).toMatch(/^\/managed\/\.hermes-web-attachments\/.+\/notes\.txt$/)
    expect(form.get('overwrite')).toBe('false')
    expect((form.get('file') as File).name).toBe('notes.txt')
    expect((form.get('file') as File).size).toBe(5)
    expect(calls[1].init.headers).not.toHaveProperty('Content-Type')
  })

  it('returns no paths on user cancellation without uploading', async () => {
    vi.stubGlobal('showOpenFilePicker', async () => {
      throw new DOMException('Canceled', 'AbortError')
    })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    expect(await picker()()).toEqual([])
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not turn upload failure into a valid-looking chip path', async () => {
    vi.stubGlobal('showOpenFilePicker', async () => [
      { getFile: async () => ({ name: 'notes.txt', type: 'text/plain', arrayBuffer: async () => new ArrayBuffer(2) }) }
    ])
    vi.stubGlobal('fetch', async (url: string) =>
      url === '/api/files'
        ? new Response(JSON.stringify({ path: '/managed' }))
        : new Response('write denied', { status: 403 })
    )
    await expect(picker()()).rejects.toThrow(/selectPaths.*403/)
  })

  it('rejects over-cap files before allocating their bytes or uploading them', async () => {
    const arrayBuffer = vi.fn()
    vi.stubGlobal('showOpenFilePicker', async () => [
      { getFile: async () => ({ name: 'large.bin', size: 17 * 1024 * 1024, arrayBuffer }) }
    ])
    const fetch = vi.fn(async () => new Response(JSON.stringify({ path: '/managed' })))
    vi.stubGlobal('fetch', fetch)
    await expect(picker()()).rejects.toThrow(/16 MiB gateway read limit/)
    expect(arrayBuffer).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('refuses browser directory names as gateway paths', async () => {
    await expect(picker()({ directories: true })).rejects.toThrow(/Browser folders have no gateway path/)
  })
})

// The composer's browser-held bytes (a pasted clipboard image, a huge text
// paste, the Paste-image menu item) stage through the SAME managed area as the
// picker. MEASURED before these were wired: all three members were `cut` (the
// optional-chained calls silently no-op'd), so a pasted image produced no chip
// and a 30k-character paste stayed inline. The member returns a real gateway
// path and refuses to fake one when the upload fails.
describe('web bridge byte staging (saveImageBuffer / savePastedText / saveClipboardImage)', () => {
  afterEach(() => vi.unstubAllGlobals())

  function stubManagedRoot(uploadPath = '/managed/.hermes-web-attachments/x/entry.bin') {
    const calls: Array<{ url: string; init: RequestInit }> = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init })
      return new Response(JSON.stringify(url === '/api/files' ? { path: '/managed' } : { path: uploadPath }))
    })
    return calls
  }

  it('saveImageBuffer stages bytes and returns the gateway path, with a source filename when given', async () => {
    const calls = stubManagedRoot('/managed/.s/.a/screenshot.png')
    const bytes = new Uint8Array([1, 2, 3])
    const saved = await (createWebBridge().saveImageBuffer as (d: Uint8Array, e: string, n?: string) => Promise<string>)(
      bytes,
      '.png',
      'shot.png'
    )
    expect(saved).toBe('/managed/.s/.a/screenshot.png')
    const upload = calls.find(c => c.url.startsWith('/api/files/upload-stream'))
    expect(upload).toBeDefined()
    const form = upload!.init.body as FormData
    expect(form.get('path')).toMatch(/^\/managed\/.hermes-web-attachments\/.+\/shot\.png$/)
    expect(form.get('overwrite')).toBe('false')
  })

  it('saveImageBuffer names an unnamed buffer after the extension', async () => {
    stubManagedRoot('/managed/.s/.a/x.png')
    const calls = stubManagedRoot('/managed/.s/.a/x.png')
    await (createWebBridge().saveImageBuffer as (d: Uint8Array, e: string) => Promise<string>)(new Uint8Array([1]), '.png')
    const form = (calls.find(c => c.url.startsWith('/api/files/upload-stream'))!.init.body as FormData)
    expect((form.get('file') as File).name).toMatch(/\.png$/)
  })

  it('savePastedText keeps the pasted_content name shape and the text bytes', async () => {
    const calls = stubManagedRoot('/managed/.s/.a/p.txt')
    const saved = await (createWebBridge().savePastedText as (t: string) => Promise<string>)('body text')
    expect(saved).toBe('/managed/.s/.a/p.txt')
    const form = (calls.find(c => c.url.startsWith('/api/files/upload-stream'))!.init.body as FormData)
    expect((form.get('path') as string)).toMatch(/pasted_content_.+\.txt$/)
    expect(await (form.get('file') as File).text()).toBe('body text')
  })

  it('saveClipboardImage returns null with no image on the clipboard and does not upload', async () => {
    const calls = stubManagedRoot('/managed/.s/.a/x.png')
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(Object.getPrototypeOf(navigator)), { clipboard: { read: async () => [] } })
    )
    expect(await (createWebBridge().saveClipboardImage as () => Promise<string | null>)()).toBeNull()
    expect(calls.filter(c => c.url.startsWith('/api/files/upload-stream'))).toHaveLength(0)
  })

  it('saveClipboardImage stages a clipboard image item', async () => {
    const calls = stubManagedRoot('/managed/.s/.a/clip.png')
    const blob = new Blob([new Uint8Array([9, 9, 9])], { type: 'image/png' })
    vi.stubGlobal(
      'navigator',
      Object.assign(Object.create(Object.getPrototypeOf(navigator)), {
        clipboard: {
          read: async () => [
            {
              types: ['image/png', 'text/plain'],
              getType: async (t: string) => (t === 'image/png' ? blob : new Blob())
            }
          ]
        }
      })
    )
    const saved = await (createWebBridge().saveClipboardImage as () => Promise<string | null>)()
    expect(saved).toBe('/managed/.s/.a/clip.png')
    const form = (calls.find(c => c.url.startsWith('/api/files/upload-stream'))!.init.body as FormData)
    expect(form.get('path')).toMatch(/clipboard-image-.+\.png$/)
  })

  it('an upload failure propagates under the calling member, never a fake path', async () => {
    vi.stubGlobal('fetch', async (url: string) =>
      url === '/api/files'
        ? new Response(JSON.stringify({ path: '/managed' }))
        : new Response('write denied', { status: 403 })
    )
    await expect(
      (createWebBridge().savePastedText as (t: string) => Promise<string>)('x')
    ).rejects.toThrow(/savePastedText.*403/)
  })
})
