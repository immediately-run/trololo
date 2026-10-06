// Dev-only round-trip check for the local `fs` bridge (vite-plugin-dev-fs).
// Loaded from main.tsx only when import.meta.env.DEV is true, so it never ships
// to immediately.run (which ignores main.tsx) nor to production builds (the
// branch is stripped). Open the browser console to see the result.
import fs from 'fs'

const DIR = '/devfs-playground'

export async function runDevFsSmokeTest(): Promise<void> {
  const file = `${DIR}/smoke.txt`
  const stamp = `hello from dev-fs @ ${new Date().toISOString()}`

  console.groupCollapsed('%c[dev-fs] smoke test', 'color:#c026d3;font-weight:bold')
  try {
    await fs.promises.mkdir(DIR, { recursive: true })

    await fs.promises.writeFile(file, stamp, 'utf8')
    const back = await fs.promises.readFile(file, 'utf8')
    console.log('write/read:', back === stamp ? 'OK' : `MISMATCH → ${back}`)

    const st = await fs.promises.stat(file)
    console.log('stat:', { size: st.size, isFile: st.isFile(), isDirectory: st.isDirectory() })

    console.log('readdir:', await fs.promises.readdir(DIR))

    // watch: subscribe, trigger a change, confirm an event arrives.
    const ac = new AbortController()
    const firstEvent = (async () => {
      for await (const ev of fs.promises.watch(DIR, { signal: ac.signal })) return ev
      return null
    })()
    await delay(150) // let the server-side watcher attach
    await fs.promises.writeFile(`${DIR}/touch-${Date.now()}.txt`, 'x', 'utf8')
    const ev = await Promise.race([firstEvent, delay(2000).then(() => null)])
    console.log('watch:', ev ? `OK → ${JSON.stringify(ev)}` : 'no event within 2s')
    ac.abort()

    console.log('%cdev-fs is live — fs writes land on your local disk under the project root.', 'color:#16a34a')
  } catch (err) {
    console.error('[dev-fs] smoke test failed:', err)
  } finally {
    console.groupEnd()
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
