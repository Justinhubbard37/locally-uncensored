# LU 2.5.7 — Onboarding ohne externe Provider (Built-in Engine)

**Master-Plan für den autonomen Lauf. Noch nichts implementiert.**
Ziel: Beim neuen Launch (2.5.7) ist das Chat-Onboarding **komplett unabhängig
von Ollama / LM Studio**. Die App bringt ihre eigene Inference-Engine mit
(gebündeltes `llama.cpp`-Server-Binary). Externe Provider werden weiterhin
*erkannt und optional genutzt*, aber nie mehr *vorausgesetzt*.

---

## 0. Prinzip

- **Nicht** Inference selbst schreiben. Wir bündeln `llama.cpp` (`llama-server`),
  dieselbe Engine, die Ollama/LM Studio intern nutzen.
- **Maximaler Reuse:** `llama-server` spricht eine **OpenAI-kompatible API**
  (`/v1/chat/completions`, SSE-Streaming). Die App hat bereits einen voll
  funktionierenden `OpenAIProvider` + Rust-Proxy + Token-Streaming. Der neue
  „Built-in"-Backend ist damit nur ein **weiterer lokaler OpenAI-Backend** mit
  von uns verwaltetem Lifecycle — kein neuer Provider-Typ nötig.
- **Hybrid, nicht Rausriss:** Ollama/LM-Studio-Erkennung bleibt als „Advanced"-
  Pfad. Unabhängigkeit heißt *nicht mehr voraussetzen*, nicht *löschen*.

---

## 1. Ist-Zustand (verifiziert)

### Onboarding
- `src/components/onboarding/Onboarding.tsx` — Steps:
  `welcome → backends → comfyui → models → embeddings → done`
  (`STEP_ORDER`, Z. 28–29).
- **backends-Step (Z. 665–1045):** `detectLocalBackends()` scannt 12 lokale
  Backends. Wenn keiner da: primäre CTAs **„Install Ollama" (~570 MB)** /
  **„Install LM Studio"** via Tauri-Commands `install_ollama` / `install_lmstudio`.
  → **Genau hier sitzt die externe Abhängigkeit.**
- **models-Step (Z. 1402–1531):** lädt EIN Starter-Modell
  (`ONBOARDING_MODELS` = Qwen 2.5 0.5B GGUF, 400 MB, `lib/constants.ts`).
  Download-Routing (Z. 177–296): Ollama → `ollama pull`; LM Studio → GGUF-Datei.
- **embeddings-Step (Z. 1533–1615):** `nomic-embed-text` via `pullModelTauri`
  → **läuft heute NUR über Ollama** (RAG/Document-Chat hängt an Ollama).
- **State:** `settings.onboardingDone` (Zustand, localStorage `chat-settings`)
  + Filesystem-Marker `{APPDATA}/Locally Uncensored/onboarding_done`
  (`src-tauri/src/commands/system.rs`: `set_onboarding_done` / `is_onboarding_done`).

### Provider-Schicht
- Interface `ProviderClient` (`src/api/providers/types.ts` Z. 145–173).
- Registry-Factory (`src/api/providers/registry.ts`): schaltet auf
  `ollama | openai | anthropic`. Model-Routing per Prefix `provider::model`.
- Presets (`types.ts` Z. 32–61): u. a. bereits ein **`llama.cpp`-Preset**
  (`providerId: 'openai'`, `isLocal: true`, Port 8080/v1). → OpenAI-Pfad kann
  llama.cpp schon.
- `providerStore` (`src/stores/providerStore.ts`): Keys `ollama|openai|anthropic`,
  Default enabled = **Ollama**.
- Rust-Proxy: `proxy_localhost` + `proxy_localhost_stream_chunked`
  (`src-tauri/src/commands/proxy.rs`) — CORS/CSP-Bypass + echtes Token-Streaming
  über Tauri-Channel.

### Prozess-/Sidecar-Infrastruktur
- **Kein** `externalBin`/Sidecar in `tauri.conf.json`. Einzige gebündelte
  Ressource: `resources/whisper_server.py` (Python-Subprozess).
- Subprozess-Muster existiert: `start_ollama` (`src-tauri/src/commands/process.rs`
  Z. 637–687) — `Command::new`, Child in `AppState.ollama_process`, GPU-Env
  (`CUDA_VISIBLE_DEVICES`/`HIP_*`/`ONEAPI_*`), Windows Job-Object-Cleanup.
- `AppState` (`src-tauri/src/state.rs`): hält `ollama_process`, `comfy_process`,
  `downloads`, `gpu_selection`, `shutdown_subprocesses()`.
- Health: `src-tauri/src/commands/health.rs` — HTTP-Probes 300 ms.
- Download: `src-tauri/src/commands/download.rs` — `download_model_to_path`
  (Resume, SSRF-Guard), `detect_model_path(provider)`.

### Build / Version
- Tauri 2, React 19 + Zustand 5, Vite 8.
- **Version an 3 Stellen:** `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`,
  `package.json` — aktuell alle `2.5.5` (Mac-Build 2.5.6 existiert lokal).
- CI `.github/workflows/release.yml`: Matrix **ubuntu-22.04 + windows-latest**;
  **macOS wird lokal gebaut** (kein CI). `tauri-action`, Updater-Signing.
- Release-Profile: `lto=true`, `opt-level="s"`, `strip=true`, `panic="abort"`.

---

## 2. Ziel-Architektur

```
Onboarding (built-in default)
   │  Download GGUF → App-Models-Dir
   ▼
Rust: start_bundled_engine(model, ctx, gpu)
   │  spawnt Sidecar  llama-server  -m <gguf> --host 127.0.0.1 --port 8127 ...
   ▼
llama-server  ──OpenAI /v1/chat/completions (SSE)──►  proxy_localhost_stream_chunked
   ▲                                                        │
   └──────────── OpenAIProvider (unverändert) ◄─────────────┘
```

- **Neuer Backend `builtin`** = OpenAI-kompatibel auf verwaltetem Port,
  Lifecycle von der App gesteuert (Start/Stop/Model-Swap).
- **Model-Swap:** `llama-server` lädt 1 Modell pro Prozess → Modellwechsel =
  Prozess-Neustart mit neuem `-m`. (Ollama-artiges Verhalten, ~1–3 s.)
- **Binary:** `llama.cpp` **statisch** gebaut, Metal-Shader **eingebettet**
  (`-DGGML_METAL_EMBED_LIBRARY=ON`) → **ein einzelnes File pro Plattform**,
  ideal für Tauri-`externalBin` (kein dylib-Gefummel).

---

## 3. Entscheidungen (GELOCKT — 2026-07-06)

| # | Entscheidung | Beschluss |
|---|---|---|
| **E1** | Engine | ✅ `llama.cpp` `llama-server` als statisches Sidecar-Binary. |
| **E2** | Plattform-Scope für 2.5.7 | ✅ **mac-first** (arm64 + x86_64). Win/Linux = P6-Nachzug nach Launch. |
| **E3** | Externe Provider | ✅ **Behalten als „Advanced"**. Detection bleibt, CTAs wandern unter „andere Engine nutzen". Kein Code-Rausriss. |
| **E4** | Embeddings/RAG | ✅ **In-Scope für 2.5.7.** Voller Umbau: 2. `llama-server --embeddings` + RAG/Document-Chat auf Bundled-Embed umbiegen. Onboarding komplett Ollama-frei. → **P5 ist Kern, nicht optional.** |
| **E5** | Win/Linux GPU | Vulkan-Build (später, P6). CUDA-Variante danach. |

---

## 4. Phasenplan (autonom, Commit pro Phase)

Branch: `feat/builtin-engine`. Jede Phase: Unit-Test **und** (wo sinnvoll)
Playwright-e2e vor „done" (stehende Regel).

### P0 — Binary-Beschaffung & Build-Skript
- **Neu:** `scripts/build-llama.sh` — klont `llama.cpp` auf **gepinnten Tag**,
  cmake-Build mit:
  - mac: `-DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON -DBUILD_SHARED_LIBS=OFF`
  - win/linux: `-DGGML_VULKAN=ON -DBUILD_SHARED_LIBS=OFF`
  - kopiert `llama-server` → `src-tauri/bin/llama-server-<target-triple>[.exe]`.
- **Neu:** `src-tauri/bin/.gitignore` (Binaries **nicht** committen; im Build/CI
  erzeugt → kein Repo-Ballast, „no mess").
- Triples: `aarch64-apple-darwin`, `x86_64-apple-darwin`,
  `x86_64-pc-windows-msvc`, `x86_64-unknown-linux-gnu`.
- **Verifikation:** Skript lokal (mac arm64) → Binary startet,
  `curl 127.0.0.1:PORT/health` = ok, `/v1/models` antwortet.

### P1 — Rust: Sidecar-Lifecycle
- `tauri.conf.json` → `bundle.externalBin: ["bin/llama-server"]`
  (Tauri hängt Target-Triple automatisch an, signiert auf mac mit).
- **Neu:** `src-tauri/src/commands/engine.rs`:
  - `start_bundled_engine(model_path, ctx, gpu) -> u16` (Port, Sidecar-Resolve,
    `-m --host 127.0.0.1 --port --ctx-size -ngl 999` + GPU-Env, Child in State,
    auf `/health` warten).
  - `stop_bundled_engine()`, `bundled_engine_status()`,
    `swap_bundled_model(model_path)` (stop→start), `list_bundled_models()`
    (App-Models-Dir nach `*.gguf` scannen, geladenes markieren).
- `state.rs`: `bundled_engine: Mutex<Option<BundledEngine>>`
  ({child, model_path, port}); in `shutdown_subprocesses()` killen.
- `download.rs::detect_model_path`: `"builtin" =>` App-Data
  `.../Locally Uncensored/models` (auto-create).
- `main.rs`: Commands in `invoke_handler` registrieren.
- **Verifikation:** Rust-Unit-Test start/status/stop; manuell Chat-Roundtrip
  gegen den Sidecar.

### P2 — Frontend: Built-in-Backend verdrahten
- `types.ts`: Preset
  `{ id: 'builtin', name: 'Built-in Engine', providerId: 'openai',
     baseUrl: 'http://127.0.0.1:8127/v1', isLocal: true, managed: true }`.
- `registry.ts` / `providerStore.ts`: `builtin` → `OpenAIProvider` mit
  verwaltetem Base-URL; Default-enabled **von `ollama` auf `builtin`** umstellen.
  `managed`-Flag: kein User-URL/Key-Input, Lifecycle über Tauri-Commands.
- Model-Liste für `builtin` = `list_bundled_models` (nicht `/v1/models`, weil
  nur das geladene Modell erscheint). Modellwahl → `swap_bundled_model`.
- **Verifikation:** Unit-Test Registry-Routing `builtin→OpenAIProvider`;
  Chat-Stream-Test.

### P3 — Onboarding-UX
- **backends-Step:** neue Default-Karte **„Built-in Engine — nichts zu
  installieren"** (vorausgewählt). `detectLocalBackends()` bleibt; gefundene
  Ollama/LM-Studio erscheinen als **„Ebenfalls erkannt … (Advanced)"**. Die
  großen Install-CTAs wandern unter ein aufklappbares **„Andere Engine nutzen"**.
- **models-Step:** GGUF → App-Models-Dir (`download_model_to_path`), danach
  `start_bundled_engine`. Progress-Store unverändert nutzbar.
- **finish():** unverändert (`onboardingDone` + Marker).
- **Verifikation:** Playwright-e2e **Fresh-Onboarding**: welcome → built-in →
  Modell laden → Chat senden → Antwort. **Das ist der Akzeptanztest.**

### P4 — „Andere Engine" / Advanced-Settings
- Backend-Switcher (`BackendSelector.tsx`, Settings→Providers) zeigt `builtin`
  als Standard; Ollama/LM Studio wählbar wenn erkannt.
- Ollama/LM-Studio-Install-Buttons bleiben erreichbar (Advanced), nur nicht mehr
  im kritischen Onboarding-Pfad.

### P5 — Embeddings-Unabhängigkeit (E4, IN-SCOPE)
- 2. `llama-server --embeddings` auf eigenem Port mit Embedding-GGUF
  (`nomic-embed-text` / `bge-small` GGUF), eigener Lifecycle in `engine.rs`
  (`start/stop_bundled_embed`), Child in `AppState.bundled_embed`.
- **RAG-Umbau:** alle Aufrufe, die heute Ollama-`/api/embeddings` nutzen
  (Document-Chat, Memory-Embeddings), auf OpenAI-`/v1/embeddings` gegen den
  Bundled-Embed-Server umbiegen. → Ollama-Referenzen im RAG-Pfad suchen &
  ersetzen (Codebase-Sweep vor Umbau).
- Onboarding-embeddings-Step: statt `ollama pull` → GGUF-Download + Embed-Server
  starten. Auto-Skip-Heuristik (`embed`/`bge-`/`nomic`) beibehalten.
- **Verifikation:** e2e Document-Chat gegen den Bundled-Embed (kein Ollama läuft).

### P6 — Windows/Linux (nach mac-Launch)
- `build-llama.sh` Vulkan-Pfad; CI `release.yml` Matrix-Step
  „llama.cpp bauen vor `tauri build`".
- Windows-Defender-Whitelisting/Signing des Sidecars prüfen.

### P7 — Version, Cleanup, Doku
- Version `2.5.5 → 2.5.7` in **allen 3** Dateien.
- `bundle.longDescription`: „built-in engine, zero setup" ergänzen.
- Marketing-Copy (Onboarding-welcome) auf „läuft sofort, ohne Fremdsoftware".

---

## 5. Test-Strategie
- **Rust unit:** engine start/stop/status/swap (echtes Binary in CI-Job).
- **Frontend unit:** Registry-Routing, `list_bundled_models`, Model-Swap-Aktion.
- **Playwright e2e (Pflicht):** Fresh-Onboarding-Happy-Path bis erste
  Chat-Antwort über die Built-in-Engine; zweiter Lauf: Modellwechsel.
- **Regression:** Ollama-Pfad (falls installiert) weiterhin nutzbar.

## 6. Build / CI / Packaging
- `externalBin` → Tauri kopiert + signiert Sidecar in App-Bundle (mac).
- **Notarization prüfen:** Sidecar muss mit-notarisiert werden (Hardened Runtime,
  Entitlements für JIT falls nötig). Kritischer mac-Risikopunkt.
- CI: llama.cpp-Build-Step **vor** `tauri build` je Plattform.
- App-Größe: +~30–80 MB/Plattform (akzeptabel, dokumentieren).

## 7. No-Mess-Checkliste
- [ ] Sidecar-Binaries **nicht** im Git (nur Build-Artefakt).
- [ ] Kein toter Feature-Flag; `builtin` ist echtes Feature.
- [ ] Ollama/LM-Studio-Code bleibt funktional (Advanced), keine `_unused`-Leichen.
- [ ] `onboardingDone`-Marker-Semantik unangetastet.
- [ ] Version in allen 3 Dateien synchron.
- [ ] `scripts/build-llama.sh` idempotent, gepinnter Tag, reproduzierbar.

## 8. Rollback
- Alles auf `feat/builtin-engine`. Fällt Notarization/GPU: Branch nicht mergen,
  Onboarding-Default zurück auf Detection. Kein Prod-Impact bis Merge+Release.

## 9. Reihenfolge für den autonomen Lauf
`P0 → P1 → P2 → P3` = **Chat-Unabhängigkeit auf mac**.
`P4` Advanced-Politur, **`P5` Embeddings/RAG (in-scope, macht Onboarding
komplett Ollama-frei)**, `P7` Version/Release. **`P6` Win/Linux = nach Launch.**
Merge-Akzeptanz 2.5.7: e2e Fresh-Onboarding→Chat (P3) **und** e2e
Document-Chat ohne Ollama (P5) grün.
