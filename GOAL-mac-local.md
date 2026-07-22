# GOAL — LU Mac Desktop App, Local-Modus fertig bauen

Auftrag David 2026-07-22: Mac-App Local-Modus zu Ende bauen (Cloud ist fertig).
Jede Chat/Agent/Coding-Funktion + jedes Tool einzeln testen, Langzeitläufe,
5 licensed + 5 uncensored Bildmodelle und 5 licensed + 5 uncensored Videomodelle
je einmal durchlaufen. Harte Regel: Media auf Mac = MLX only, NIEMALS ComfyUI.
David-Entscheid: MLX-Media komplett neu bauen.

Branch: `feat/mac-local-mode` (von `release/2.5.7-merged`). Commit pro Schritt, kein Push.
Legende: [ ] offen · [~] in Arbeit · [x] grün (verifiziert) · [!] blockiert/ehrlicher Cap

---

## Phase 1 — Fundament (Un-wall + lauffähige Local-App)
- [~] 1.1 Wall lösen: `isCloudOnly()`→false (14 Gates schaltbar); tote Äste sauber entfernen = offen (Cleanup-Commit)
  - [x] Migration v14: Mac-Zwangs-`cloud` einmalig auf `local` zurückgesetzt (settingsStore)
- [x] 1.2 tsc (`tsconfig.app.json`) Baseline-Diff = 0 neue Fehler (331 Baseline unverändert); vitest berührte Stores 108 grün
  - [x] v14-Migrate-Unit-Test `settingsStore-migrate-v14.test.ts` 4/4 grün (Mac cloud→local, Win bleibt cloud, v14-cloud bleibt, Personas rebuild) — commit `b261e9d`
- [ ] 1.3 e2e-Specs an neuen Zustand angepasst, grün
- [~] 1.4 App startet lokal (`tauri:dev` läuft, v2.5.7); Local-Onboarding rendert (UI-Smoke :5173); Switch/Local live noch zu bestätigen
- [~] 1.5 Local-Inferenz bewiesen: Ollama :11434 (qwen2.5:0.5b) → „LOCAL OK". Nach Rust-Restart bootet App in local (kein `[Offload] cloud`). Builtin-Engine-GGUF-Download noch (Phase 2.4)
- [ ] 1.6 ComfyUI auf Mac überall aus (harte Regel), keine Crashes/Dead-Ends

## Phase 2 — Local Chat
- [ ] 2.1 Chat streamt Tokens über Builtin-Engine (Qwen)
- [ ] 2.2 Think-Toggle wo unterstützt
- [ ] 2.3 Modell-Swap (2. Modell)
- [~] 2.4 Discover-Download für Builtin-Engine: CODE FERTIG (commit `39d2f06`) — `detect_model_path` akzeptiert Anzeigename-Aliase; DiscoverModels hat Built-in-Zweig (flach schreiben → engine booten). tsc/cargo grün. Live „2. Modell lädt" = nach Rebuild
- [ ] Phase-6-Richtung (Bridge-MLX vs In-Process-MLX): Recon-Agent kartiert lu-bridge-Architektur — Ergebnis abwarten, DANN Phase 6 planen
- [ ] 2.5 Langzeit: langer Multi-Turn-Chat stabil

## Phase 3 — Agent-Modus: jedes Tool einzeln (29 Builtin + MCP)
web (auto): [ ] web_search · [ ] web_fetch
filesystem: [ ] file_read · [ ] file_write · [ ] file_list · [ ] file_search
terminal: [ ] shell_execute · [ ] code_execute · [ ] shell_execute_background · [ ] shell_task_status · [ ] shell_task_kill · [ ] shell_task_list
git: [ ] git_status · [ ] git_commit · [ ] git_push · [ ] git_log · [ ] git_diff
dev: [ ] project_init · [ ] pr_resume · [ ] gh_pr_create · [ ] run_tests
system: [ ] system_info · [ ] process_list · [ ] get_current_time
desktop: [~] screenshot — macOS-Impl NEU (`/usr/sbin/screencapture`), kompiliert; live-grün braucht Screen-Recording-Grant für LU (OS-TCC)
workflow: [ ] run_workflow · [ ] delegate_task
extern: [ ] MCP-Tool (mind. 1 externer Server)
media-Tools (in Phase 6): [ ] image_generate · [ ] video_generate (via MLX)

## Phase 4 — Coding (Codex) Modus
- [ ] 4.1 Codex-Tools verfügbar (builtin minus desktop/workflow)
- [ ] 4.2 Ganze Multi-Datei-Coding-Aufgabe live grün
- [ ] 4.3 Review-Mode strippt mutierende Tools (verifiziert)

## Phase 5 — Langzeitläufe / Stabilität
- [ ] 5.1 Langer Agent-Run (viele Tool-Calls, mehrstufig)
- [ ] 5.2 Langer Coding-Run
- [ ] 5.3 Memory + RAG über lange Session persistent
- [ ] 5.4 Kein Leak/Absturz, RAM sauber (offload wo nötig)

## Phase 6 — MLX-Media Neubau (Mac, only MLX)
- [ ] 6.1 MLX-Runtime: Bild+Video-Python-Env geklärt + installier-/bundle-bar
- [ ] 6.2 Rust: `mlx_image_generate` + `mlx_video_generate` (ersetzt ComfyUI-Pfad auf Mac)
- [ ] 6.3 Frontend: Mac-Local-Create → MLX, ComfyUI-Pfad Mac aus, Backend-Pin mlx
- [ ] 6.4 Bild-Katalog: 5 licensed
  - [ ] img-L1 · [ ] img-L2 · [ ] img-L3 · [ ] img-L4 · [ ] img-L5
- [ ] 6.5 Bild-Katalog: 5 uncensored
  - [ ] img-U1 · [ ] img-U2 · [ ] img-U3 · [ ] img-U4 · [ ] img-U5
- [ ] 6.6 Video-Katalog: 5 licensed (ehrlicher Cap möglich)
  - [ ] vid-L1 · [ ] vid-L2 · [ ] vid-L3 · [ ] vid-L4 · [ ] vid-L5
- [ ] 6.7 Video-Katalog: 5 uncensored (ehrlicher Cap möglich)
  - [ ] vid-U1 · [ ] vid-U2 · [ ] vid-U3 · [ ] vid-U4 · [ ] vid-U5
- [ ] 6.8 Jedes Bildmodell 1x durchgelaufen (billigste Settings)
- [ ] 6.9 Jedes Videomodell 1x durchgelaufen (billigste Settings)

## Phase 7 — Abschluss
- [ ] 7.1 tsc + vitest + e2e grün, Baseline-Diff sauber
- [ ] 7.2 Live-Green-Log je Goal-Punkt festgehalten
- [ ] 7.3 Commit pro Schritt, Zusammenfassung, kein Push (Davids Go)
