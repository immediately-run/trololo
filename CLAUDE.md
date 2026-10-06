# Working in this repo — trololo

This is **Trololo**, the proof of concept for `COLLABORATION_SESSIONS_SPEC` §15 (docs repo): a
Trello-like board edited live in a collaboration session, with git as the truth at rest. Code map:

- `src/lib/session/` — the session engine: a **pure** library (no React, no SDK, no `Date.now`, no
  `localeCompare` — `npm run lint` enforces it). One module per concept; `engine.ts` is the façade.
  `README.md` lists the modules.
- `test/oracle/reference.ts` — an independent oracle written from the spec text. It may import only
  `layout.ts` and `canonical.ts` from the engine; never `fold.ts` or `effective.ts`.
- `test/sim/` — simulated git, transport and replicas; publish commits are built by the oracle.
- Changing merge semantics means changing the spec first, then the engine **and** the oracle
  independently; the convergence property compares them.

It is also an **immediately.run app**: React + TypeScript that loads from GitHub and
transpiles in the browser (no server, no build step at runtime). Keep the rules
below or the app breaks *only* on immediately.run while still looking fine in
local `vite dev` — the most common silent failure.

## Hard rules (these break immediately.run if violated)

1. **`src/App.tsx` is the entry point.** immediately.run renders its **default
   export**. `src/main.tsx` is for local dev/build only and is **ignored** at
   runtime — never put CSS imports, providers, or app logic there.
2. **Import global CSS from `App.tsx`**, not from `main.tsx`. Anything the
   rendered tree needs (CSS, context providers) must be reachable from
   `App.tsx`.
3. **A file that exports a React component exports ONLY components.** No mixing a
   component with named exports of data/constants/helpers. (`interface`/`type`
   are erased at compile time and are fine.) This is the React Fast Refresh rule;
   `npm run lint` enforces it. Put data in `src/data/`, hooks in `src/hooks/`,
   utilities in `src/lib/`.
4. **One component per file, default-exported**, named for what it renders.
5. **CSS lives in `.css` files imported from TypeScript** — not in giant
   `<style>` blocks or inline `style={{}}` for the bulk of styling.
6. **Fonts via CSS `@import`** as the first line of the CSS file, not `<link>`
   tags in `index.html`.
7. **Import local assets** (`import logo from './assets/logo.png'`); don't
   reference server paths that won't exist in the sandbox.
8. **No Node / build-time-only APIs** in the rendered tree — it runs in a browser
   iframe. `document`, `window`, and `fetch` are available. **Web storage is
   not**: `localStorage`, `sessionStorage`, `indexedDB` and the Cache API are
   all unavailable — apps run at an opaque origin (a sandboxed iframe without
   `allow-same-origin`; `BROWSER_CAPABILITIES_SPEC` §1 in the docs repo), where
   even *reading* `localStorage` throws `SecurityError`, so a
   `typeof localStorage === 'undefined'` guard does NOT work (the throw is on
   access, not on the value). State goes to the mounts instead:
   - **Device-local, rebuildable state** (caches, drafts, scroll positions,
     checkpoints): the mount from `await openLocalStore()` in
     `@immediately-run/sdk` — per device, never synced, evictable by the
     browser under storage pressure.
   - **Synced state**: `openSettings()`.
   - Both need a signed-in user: `openLocalStore()` rejects `auth-required`
     when signed out, so the app degrades to in-memory state rather than
     crashing (platform security model rule 9). Treat persistence as optional
     and keep the app fully usable without it.

   Worked example: `src/hooks/useTheme.ts` — the in-memory fallback for
   signed-out use; moving its persistence onto `openLocalStore()` is per-app
   work.
   **Downloading a blob works; *navigating* to one does not.** A clicked
   `<a download href="blob:...">` saves the file — the frame carries
   `allow-downloads` in every stance, and the opaque origin does not stop it.
   But `location.assign(blobUrl)` / `window.open(blobUrl)` silently does nothing
   for a type the browser would display, because the document that navigation
   creates gets a *fresh* opaque origin and can no longer resolve the blob. (For
   a type Chrome will not display, such as `text/csv`, it converts the
   navigation into a download — which is why the two paths look inconsistent.)
   So build exports on `<a download>`, and never on "open it in a tab".
   Measured 2026-08-29 (roadmap R3-417).
9. **MDX is only for long-form prose** (articles, guides). Structured/repeated
   data stays as typed arrays in `src/data/`. If you add `.mdx`, the Vite plugin
   and `src/mdx.d.ts` shim are already wired up.

## Loading & caching on immediately.run

`.github/workflows/cache.yml` publishes a pre-cached zip of this repo to its own
GitHub Pages on each push to `main`, so immediately.run loads fast and within
anonymous rate limits. To enable it on a repo in your own account/org, turn Pages
on once — **Settings → Pages → Source: GitHub Actions** — then push to `main`; no
tokens or secrets. (immediately-run org repos self-provision Pages on the first
run via the org's internal deploy GitHub App: its
`DEPLOY_APP_ID`/`DEPLOY_APP_PRIVATE_KEY` org secrets are scoped to all
repositories in the org, so the mint step runs on a brand-new repo and no manual
step is needed — provided the repo is **public**, since on the Free plan org
secrets are unreadable by private repos and Pages needs a public repo anyway.
Outside the org there is no App — enable Pages once with
`gh api -X POST repos/<owner>/<repo>/pages -f build_type=workflow` then
`gh workflow run cache.yml`, or the manual Settings → Pages step.) Don't move the
cache to a different path or hostname — the client discovers it by convention at
`https://<owner>.github.io/<repo>/cached_repositories/main.zip` (branch-keyed) and
`cached_repositories/<sha>.zip` (what a commit-pinned library mount probes).

`"immediately.run": { "requireLatest": "..." }` in `package.json` controls
freshness. It is a **string enum**, not a boolean: `"stale_ok"` (always serve
the cache, fastest, offline-friendly), `"optimistic"` (the default — serve
cache, check in background), or `"strict"` (always run the newest commit, at
the cost of a freshness check on launch). Leave it unset unless
to-the-commit freshness matters; the default is fast and works offline.

## Design system

This brand is: cool near-black canvas · magenta↔violet signature gradient ·
Gabarito display type · Space Mono details · hairline borders · hard-offset hover
shadows · sentence case · headlines end on a period · **no emoji**. Dark is the
default; a light theme is wired via `data-theme="light"` on `<html>`.

- **Pull tokens from `src/index.css`** (`--bg`, `--panel`, `--ink`, `--accent`,
  `--grad`, `--r-lg`, `--shadow-card`, the type families, etc.) instead of
  hard-coding colors, radii, or fonts.
- Apply the signature gradient to text with `className="grad-text"`.
- For icons beyond the unicode set (`→ ★ ● ☀ ☾`), use
  [Lucide](https://lucide.dev) at 16–24px, `currentColor`. No emoji.

## Finding the SDK API (read this before guessing imports)

Everything the platform offers comes from `@immediately-run/sdk`. Don't guess
export names or signatures — look them up. The package ships full API docs,
fetchable in one request and optimized for both humans and coding agents:

- **`llms.txt`** — <https://immediately-run.github.io/immediately-run-sdk/llms.txt> —
  a concise map of every export grouped by module, with its kind, import path,
  and a one-line description. **Start here.**
- **`api.json`** — <https://immediately-run.github.io/immediately-run-sdk/api.json> —
  the complete TypeDoc model (exact signatures, parameters, types) when you need
  more than the one-liners.
- **HTML reference** — <https://immediately-run.github.io/immediately-run-sdk/> —
  human-browsable.

Once installed, `node_modules/@immediately-run/sdk` ships `.d.ts` carrying the
same JSDoc, so your editor/agent reads the typed API inline with no network. All
exports are importable from the package root (`@immediately-run/sdk`) or a
per-module subpath (`@immediately-run/sdk/hooks`).

## Keep your corner controls clear of the platform pill

On immediately.run the **platform pill floats over your app's top-right corner**
(it is how the user reaches the platform menu). Anything you anchor there — a
theme toggle, a menu button, a close affordance — can end up underneath it, and
your app cannot measure the pill: it is host chrome, outside your iframe.

The host reports the covered box on the form-factor channel, as
`insets: { top, right, bottom, left }` in CSS px.

Read it as a **rectangle per edge**: each number is the distance inward from that
edge of your viewport where platform chrome may sit, and the chrome is in the
**intersection** of the nonzero bands. Today that means a nonzero `top` and
`right` with `bottom`/`left` at 0 — i.e. only the **top-right corner rectangle**
is covered. All zeros means nothing is over you (`vite dev`, edit mode, or a host
that does not report it — the field is additive, so it is always safe to read).

**Pad the control, not the layout.** This template ships the wiring: `index.css`
declares `--chrome-inset-top` / `--chrome-inset-right` (0 by default) and
`nav.top .cta` pads itself by them in `App.css`. Feed them from the host, once,
near your root:

```ts
const { insets } = useFormFactor();
useEffect(() => {
  const root = document.documentElement;
  root.style.setProperty('--chrome-inset-top', `${insets.top}px`);
  root.style.setProperty('--chrome-inset-right', `${insets.right}px`);
}, [insets.top, insets.right]);
```

Do **not** reserve a permanent gutter or push your whole page down: apps with
nothing in that corner should pay nothing, and full-bleed content is meant to run
underneath it.

Two caveats while this is landing. The host pushes `insets` today, but
`useFormFactor()` does not surface it yet — the field is part of the frozen
sandbox↔SDK wire contract and lands with a `@immediately-run/sandbox-protocol`
release (roadmap R3-415). Until then the vars stay 0 and your layout is unchanged,
so the wiring above is safe to write now. Separately, `chrome:read`'s overlay
state tells you whether a *transient* platform menu is open right now — a
different question from where chrome sits at rest.

## Platform security model (what your app can and can't do)

Your app runs in a **sandboxed iframe with an opaque origin**. The rules below
follow from that and from the platform capability model
(`docs/specs/UI_AS_APPS_SPEC.md` §8 in the docs repo). Violations don't just
break your app — calls fail with typed errors, and trying to work around them
reads as hostile. (Enforcement is rolling out per the spec's §10 ladder —
items 4, 6 and 8 describe machinery that is specified but not yet live; write
new code as if they're enforced and it will keep working as they land.)

1. **All platform interaction goes through `@immediately-run/sdk`.** There is
   no other channel: no shared storage with other apps, no reaching sibling
   iframes, no postMessage of your own to the parent.
2. **Never handle user credentials.** You will never see the user's GitHub
   token, API keys, or any secret — sign-in and privileged actions are
   host-driven. Call protocol methods reactively, gated on
   `getAuthState().status === 'signed-in'`; never store or request tokens.
3. **The filesystem you see is the filesystem you got.** Mounts the host gives
   you (your app's spaces, granted folders) are your whole world — outside
   paths don't exist, and a grant may be read-only. Don't probe for escapes
   (`..`, absolute paths); writes to read-only mounts fail with `EROFS`.
4. **Access to more data is asked for, not taken.** Need another space or
   folder? Call the SDK request method and the *user* picks in host UI. Expect
   `{ ok: false, code: 'cancelled' | 'forbidden' }` and handle it gracefully.
5. **Handle typed errors everywhere.** Platform calls reply
   `{ ok: false, code, message }` (`forbidden`, `auth-required`, `cancelled`,
   `invalid-params`, …). `forbidden` means your app lacks that capability —
   that's policy, not a bug to retry around.
6. **Declare what you invoke and provide.** Cross-app tasks go in
   `package.json` under `"immediately.run"`: `"invokes"` for task contracts
   you call, `"provides"` for ones you implement. Undeclared invocations are
   rejected.
7. **Don't imitate host chrome.** Never render fake sign-in prompts, consent
   dialogs, or the platform's seam/header UI. The host draws those; imitations
   are treated as spoofing.
8. **If you embed an LLM agent, its tool list is your catalog.** Use the
   SDK-provided method catalog as the agent's tools — it is pre-filtered to
   your app's grants, so the agent can't exceed what your app may do. Don't
   hand-roll tools that shell around the SDK.
9. **Expect cancellation and absence.** Interactive flows can resolve
   `cancelled`; capabilities can be absent on a fork of your app. Degrade
   features, don't crash.

## Editing: delegate to the platform editor

**Your app's default text/code/file editing experience is the platform editor,
not a bespoke in-app editor.** When the thing the user edits *is* a file (a
Markdown/MDX note, a JSON config, a source module, a CSV), hand that file to the
platform's editing surface instead of shipping your own `<textarea>` or code
editor. This is the same instinct as not reimplementing sign-in or PR review:
there is already a good, forkable, mobile-capable, agent-readable editor — use it.
(Full rationale and the proposed platform additions are in
`docs/specs/EDITOR_FIRST_EDITING_SPEC.md`.)

1. **Edit a file in one of your mounts via the `edit-file` task.** Delegate a
   capability for exactly that one file; the host opens the editor and tears the
   delegation down when done. No consent prompt — you're narrowing a grant you
   already hold:
   ```ts
   import { invokeTask, capFile } from '@immediately-run/sdk';
   await invokeTask('edit-file', {
     file: capFile({ mountId: 'space:abc', relPath: 'notes/idea.mdx' }, { mode: 'rw' }),
   });
   ```
   This is exactly how Lodestar's "Open source" button works.
2. **Offer "edit" as an affordance on the item, not a mode of your app.** Select
   an object / focus a row → an edit icon that opens *that* file. Keep your
   run-mode UI free of editor chrome (run-mode comes first).
3. **Gate the affordance on writability.** Show it only when the mount is `rw`;
   re-evaluate on `onMountsChange` and hide it on a role downgrade. Never show a
   button that comes back `read-only`/`forbidden`, and never surface `EROFS` as UX.
4. **A few typed fields is a form, not an editor.** An inspector that sets a
   color, tags, or a lock toggle should be inline UI. Reach for the platform
   editor for the free-form body / the whole file.
5. **Build a real in-app editor only with a stated reason** — the content isn't a
   file the platform editor can edit (freehand drawing, a node graph,
   direct-manipulation geometry), or a measured UX need the platform editor can't
   meet. Write the reason down; convenience is not a reason.
6. **Known gaps (don't paper over them with a `<textarea>`):** an app running in
   *present* mode can't yet summon the edit experience on its **own source**, and
   opening a specific mounted file in the *main* editor (vs. the `edit-file`
   overlay) from a standalone app isn't supported yet. Both are specified as
   proposed deltas in `EDITOR_FIRST_EDITING_SPEC.md` §6; until they land, rely on
   the `edit-file` task and the host's edit experience rather than rolling your own.

## Verify before you're done

```bash
npm run build   # must pass with no type errors
npm run lint    # must pass — this is the cheapest proof the Fast Refresh rule holds
```

Then eyeball the page (`npm run dev`) and click any interactive controls.

## Persistence: start from `src/lib/store.ts`

Every app that keeps data re-derived the same storage pattern; it ships in the
template now so it is copied, not rediscovered: **private settings first**
(`openSettings()` — per-user, per-app, no prompt), **a remembered data space**
(create once with consent, then re-open by id from settings — only the create
path prompts), **one JSON record per file** (the platform fs is
last-write-wins per file; records keep writes from contending and reads
whole). `openAppStore()` handles the whole flow, degrades to an in-memory
session when signed out or declined, and `watchRecords` uses `fs.watch`
(remote changes ARE delivered as watch events) with a poll fallback on older
hosts. Seeding is idempotent and the `seeded` marker is written last — see the
StrictMode truth below.

## Platform truths (facts every app here has hit; read once, save an hour)

These are behaviors of the real environment, not bugs in your code. Each cost a
builder a debugging session during the example-app program (2026-08); they are
one line each so they get read.

**Lint / React**

- `eslint-plugin-react-hooks` **v7** rejects `setState` calls inside `useEffect`
  (and `ref.current = x` during render) — v7 makes these hard errors. Derive
  values during render instead of syncing them into state (`const x = useMemo(`
  or plain derivation, not `useEffect(() => setX(...))`); when a component must
  reset when an identity changes, **remount by key** (`<Panel key={id} />`), not
  via an effect. Both patterns are the accepted resolutions.
- React **StrictMode runs your boot effect twice** in dev — first-run seeding
  must be idempotent. Write a `seeded` marker file **last** (after all seed
  files) and single-flight the seed; note a one-shot `useRef` guard is *not*
  enough (StrictMode discards the first ref, leaving a "Loading…" app forever).
  The platform tolerates concurrent writes (a lost create-race no longer
  `EEXIST`s), but your seed should still be order-independent.

**What works in the sandbox (don't assume it doesn't)**

- `window.confirm` / `window.alert` **work** in the app frame.
- `crypto.subtle` and `crypto.getRandomValues` **work** (plus the SDK-shimmed
  `crypto.randomBytes`).

**What doesn't**

- **Blob *navigation* does nothing** for a type the browser would display:
  `location.assign(blobUrl)` / `window.open(blobUrl)` silently does nothing,
  because the document that navigation creates gets a *fresh* opaque origin and
  can no longer resolve the blob. **Downloading works** — a clicked
  `<a download href="blob:...">` saves the file (the frame carries
  `allow-downloads` in every stance; measured R3-417). So build exports on
  `<a download>`, never on "open it in a tab".
- `localStorage` — see hard rule 8 (throws on *access* at the opaque origin;
  state goes to `openLocalStore()` / `openSettings()` instead).

**Host vs `vite dev` differences**

- `useFormFactor()` reports **desktop** under `vite dev` (the host channel is
  absent locally); only the host gives the real answer.
- `useAuth()` **never settles** under `vite dev`, and on the host `user` is
  `null` until the user has actually signed in — build the signed-out state as
  a first-class UI, not an error.
- `sdk/tasks` must be **lazy-imported** (`await import('@immediately-run/sdk/tasks')`
  inside the code path that needs it) — the module has an eval-time side effect
  that misbehaves under `vite dev`.

**Small sharp edges**

- `SandboxMount.name` is **absent right after `createSpace`** resolves — fall
  back to your own name for the first render, don't dereference it.
- An interactive SVG group (`<g>`) containing a `<text>` label can vanish from
  the accessibility tree — put the accessible name/role on the `<g>` (or wrap
  in a `<button>`) rather than relying on the text child.
- The SDK is **pinned exactly** in `package.json` (the platform resolves the
  pin, and a `^` range resolves to its *floor* — a stale major-minor silently).
  A scheduled workflow here fails when the pin drifts behind npm; bump it in
  the same PR as your app changes that need the new API.

## Debugging on immediately.run (not just `vite dev`)

`vite dev` proves your app renders, but the failure mode this whole file warns about
— *"works locally, breaks on immediately.run"* — only shows up **running inside the
host**: the sandboxed iframe, the SDK channel, the capability gate. Debug there too.

- **Drive a real browser with Chrome DevTools MCP.** The `mcp__chrome-devtools__*`
  tools navigate the page, take an accessibility **snapshot** (element `uid`s to
  click/fill), run JS with **`evaluate_script`**, and read the **console** +
  **network** — which is where SDK `{ ok: false, code }` replies and sandbox errors
  actually surface. Reproduce, then `list_console_messages` /
  `list_network_requests`; don't guess from the rendered DOM alone.
- **Run your app *on the host*, with no commit, via the `local` provider.** Mount
  your working tree into the real host and edit live:
  ```bash
  immediately.run dev . --origin https://local.immediately.run --json
  # → open the printed /edit/local/<name>-<hash8>/.../live#ir-endpoint=…&ir-token=… link
  ```
  Edits on disk hot-reload in the host preview, so you exercise the *real* SDK +
  capability path (consent prompts, `forbidden`, mounts) instead of a local stub. A
  dev-served app gets a **fresh appKey** with no prior grants — handy for testing
  your first-run consent flow honestly. (`@immediately-run/cli`, Node ≥ 18, git
  repo.)
- **Always use `https://local.immediately.run`, never `localhost`** — config is
  keyed by hostname and only the `*.immediately.run` origin is fully wired
  (sandbox + backend + auth allowlist).
- **A passkey / Touch-ID prompt can't be automated** — the first secret unseal or
  sign-in raises a native dialog; hand that step to a human, or reload after it's
  cached.

> The platform repo also ships a `window.__irTest` host hook for scripting
> space/share drills, but that is **host-internal** (dev builds of immediately.run
> itself) — not something your app uses or should rely on. The full platform-side
> workflow lives in the docs repo's `tutorials/browser_debugging/`.
