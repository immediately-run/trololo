import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.tsx'

// Local-dev / production entry point. immediately.run does NOT use this file —
// it renders the default export of src/App.tsx directly. Keep anything the
// rendered app needs (global CSS imports, context providers) inside App.tsx,
// not here, or it will be missing when the app runs on immediately.run.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Dev-only: prove the local `fs` bridge round-trips against your disk. Stripped
// from production builds; immediately.run never loads this file. Remove freely.
if (import.meta.env.DEV) {
  void import('./dev/fsSmokeTest').then((m) => m.runDevFsSmokeTest())
}
