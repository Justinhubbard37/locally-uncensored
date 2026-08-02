// Bug BB v2.5.0 — BobbyT Discord 2026-05-26. BobbyT has AMD RX 6800XT 16GB +
// Intel Arc Pro B60 24GB and wants to pin the Arc Pro for inference. LU
// previously had no GPU picker — Ollama and ComfyUI just used whatever the
// driver picked first, which on multi-vendor / multi-GPU systems is often
// not what the user wants. This module adds:
//   1. `detect_gpus` — a one-shot probe that lists every NVIDIA / AMD / Intel
//      GPU the system can see (via nvidia-smi / rocm-smi / system_profiler /
//      lspci, best-effort).
//   2. `set_gpu_selection` — persists the user's pick into AppState. The
//      next `start_ollama` / `start_comfyui` reads from that state and sets
//      CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES / ONEAPI_DEVICE_SELECTOR
//      accordingly.
//
// Adversarial note: GPU detection on Windows without WMI is necessarily
// imprecise — we lean on the vendor CLIs (nvidia-smi, rocm-smi) and treat
// anything else as "unknown vendor, manual override required." This keeps
// the binary small and avoids the WMI dependency creep.

use crate::state::AppState;
use serde::Serialize;
use std::process::Command;
use tauri::State;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[derive(Debug, Serialize, Clone)]
pub struct DetectedGpu {
    /// Zero-based device index inside the vendor's view (this is what we
    /// pass via CUDA_VISIBLE_DEVICES / HIP_VISIBLE_DEVICES — vendor-scoped,
    /// NOT a global index across vendors).
    pub index: u32,
    pub vendor: String, // "nvidia" | "amd" | "intel" | "apple" | "unknown"
    pub name: String,
    /// Total memory in MiB if we can read it. None when the probe couldn't
    /// extract it (e.g. lspci output has no memory field).
    pub memory_mib: Option<u64>,
    /// Probe source that produced this entry. Useful for the UI tooltip
    /// ("from nvidia-smi" / "from rocm-smi" / "from lspci").
    pub source: String,
}

fn run_cmd(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    // Bounded — nvidia-smi on a wedged driver, wmic on a busy WMI service and
    // lspci on a slow bus scan all block indefinitely, and Command::output()
    // would wait for all of it while the hardware picker shows a spinner.
    crate::commands::shell::output_bounded(cmd, std::time::Duration::from_secs(5))
}

fn detect_nvidia() -> Vec<DetectedGpu> {
    // `nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader,nounits`
    // is portable across Linux and Windows. Output line: "0, NVIDIA GeForce RTX 4070, 12282"
    let raw = match run_cmd(
        "nvidia-smi",
        &["--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
    ) {
        Some(s) => s,
        None => return vec![],
    };
    raw.lines()
        .filter_map(|line| {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            if parts.len() < 3 { return None }
            let index: u32 = parts[0].parse().ok()?;
            let name = parts[1].to_string();
            let memory_mib: Option<u64> = parts[2].parse().ok();
            Some(DetectedGpu {
                index,
                vendor: "nvidia".into(),
                name,
                memory_mib,
                source: "nvidia-smi".into(),
            })
        })
        .collect()
}

fn detect_amd() -> Vec<DetectedGpu> {
    // rocm-smi exists on Linux + (rarely) Windows with ROCm-on-Windows. Output
    // varies wildly between versions; we try the simplest invocation and
    // parse loosely. Format with `--showid --showproductname`:
    //   GPU[0] : Product Name: AMD Radeon RX 6800 XT
    //   GPU[0] : Memory: 16368 MiB
    let raw = match run_cmd("rocm-smi", &["--showid", "--showproductname", "--showmeminfo", "vram", "--csv"]) {
        Some(s) => s,
        None => return vec![],
    };
    // Try CSV parse first (newer rocm-smi). Header line then card lines.
    let mut gpus: Vec<DetectedGpu> = Vec::new();
    let mut lines = raw.lines().filter(|l| !l.trim().is_empty());
    if let Some(header) = lines.next() {
        let cols: Vec<&str> = header.split(',').map(|s| s.trim()).collect();
        let card_col = cols.iter().position(|c| c.eq_ignore_ascii_case("device") || c.eq_ignore_ascii_case("card"));
        let name_col = cols.iter().position(|c| c.to_lowercase().contains("product"));
        let mem_col = cols.iter().position(|c| c.to_lowercase().contains("vram") && c.to_lowercase().contains("total"));
        for line in lines {
            let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
            let index: u32 = card_col
                .and_then(|i| parts.get(i))
                .and_then(|s| s.trim_start_matches("card").parse::<u32>().ok())
                .unwrap_or(gpus.len() as u32);
            let name = name_col
                .and_then(|i| parts.get(i))
                .map(|s| s.to_string())
                .unwrap_or_else(|| "AMD GPU".into());
            // Memory comes as bytes; convert to MiB
            let memory_mib = mem_col
                .and_then(|i| parts.get(i))
                .and_then(|s| s.parse::<u64>().ok())
                .map(|bytes| bytes / 1024 / 1024);
            gpus.push(DetectedGpu {
                index,
                vendor: "amd".into(),
                name,
                memory_mib,
                source: "rocm-smi".into(),
            });
        }
    }
    gpus
}

#[cfg(target_os = "linux")]
fn detect_other_via_lspci() -> Vec<DetectedGpu> {
    // Best-effort fallback for Intel iGPUs / Intel Arc / Apple-Silicon-in-VM
    // when neither nvidia-smi nor rocm-smi cover them. `lspci -nn | grep VGA`
    // gives "00:02.0 VGA compatible controller [0300]: Intel Corporation
    // AlderLake-S GT1 [Intel UHD Graphics 770] [8086:4680]". We parse the
    // vendor ID ([8086:...] = Intel, [10de:...] = NVIDIA fallback,
    // [1002:...] = AMD).
    let raw = match run_cmd("lspci", &["-nn"]) {
        Some(s) => s,
        None => return vec![],
    };
    let mut gpus = Vec::new();
    let mut idx_intel: u32 = 0;
    for line in raw.lines() {
        let lower = line.to_lowercase();
        if !(lower.contains("vga") || lower.contains("3d controller") || lower.contains("display controller")) { continue }
        let vendor = if lower.contains("[8086:") { "intel" }
                     else if lower.contains("[10de:") { "nvidia" }
                     else if lower.contains("[1002:") { "amd" }
                     else { "unknown" };
        // Skip NVIDIA / AMD here because nvidia-smi / rocm-smi already
        // produce better entries with memory info.
        if vendor == "nvidia" || vendor == "amd" { continue }
        // Extract the bracketed name (text between [...] just before the
        // vendor:device ID at the end).
        let name = line.split(':').last().unwrap_or(line).trim().to_string();
        gpus.push(DetectedGpu {
            index: idx_intel,
            vendor: vendor.into(),
            name,
            memory_mib: None,
            source: "lspci".into(),
        });
        if vendor == "intel" { idx_intel += 1; }
    }
    gpus
}

#[cfg(not(target_os = "linux"))]
fn detect_other_via_lspci() -> Vec<DetectedGpu> { vec![] }

#[cfg(target_os = "macos")]
fn detect_macos() -> Vec<DetectedGpu> {
    // macOS uses Metal/MPS via the unified GPU. We surface a single entry so
    // the picker isn't empty, but selection has no effect (CUDA/HIP/ONEAPI
    // env-vars don't apply on Apple Silicon).
    let name = run_cmd("sysctl", &["-n", "machdep.cpu.brand_string"])
        .map(|s| s.trim().to_string())
        .unwrap_or_else(|| "Apple GPU".into());
    vec![DetectedGpu {
        index: 0,
        vendor: "apple".into(),
        name,
        memory_mib: None,
        source: "system".into(),
    }]
}

#[cfg(not(target_os = "macos"))]
fn detect_macos() -> Vec<DetectedGpu> { vec![] }

#[cfg(target_os = "windows")]
fn detect_other_via_wmic() -> Vec<DetectedGpu> {
    // Windows fallback for Intel Arc and other GPUs that don't surface via
    // nvidia-smi / rocm-smi. Modern PowerShell deprecated wmic.exe but it's
    // still on Win10/11 Home for the time being. We probe it but treat
    // failure as benign (the user can just not see the Intel card and pick
    // "auto" instead).
    let raw = match run_cmd("wmic", &["path", "Win32_VideoController", "get", "Name,AdapterRAM", "/format:csv"]) {
        Some(s) => s,
        None => return vec![],
    };
    // AdapterRAM below is a uint32 and lies about anything past 4 GiB, so the
    // driver's registry entry is the source of truth for size when it answers.
    let registry_vram = vram_mib_by_adapter_name();
    let mut gpus = Vec::new();
    let mut idx: u32 = 0;
    // wmic `/format:csv` emits a LEADING blank line before the header row
    // ("Node,AdapterRAM,Name"). A bare `.skip(1)` would skip that blank line and
    // then parse the header itself as a device → a phantom GPU literally named
    // "Name". Filter empty lines FIRST (same as detect_amd), THEN skip the
    // header, and defensively drop the header label if the format ever shifts.
    for line in raw.lines().filter(|l| !l.trim().is_empty()).skip(1) {
        let parts: Vec<&str> = line.split(',').map(|s| s.trim()).collect();
        // Format: Node, AdapterRAM, Name
        if parts.len() < 3 { continue }
        let ram_bytes: Option<u64> = parts[1].parse().ok();
        let name = parts[2].to_string();
        if name.is_empty() || name.eq_ignore_ascii_case("name") { continue }
        let lname = name.to_lowercase();
        let vendor = if lname.contains("intel") { "intel" }
                     else if lname.contains("amd") || lname.contains("radeon") { "amd" }
                     else if lname.contains("nvidia") || lname.contains("geforce") || lname.contains("rtx") || lname.contains("gtx") { "nvidia" }
                     else { "unknown" };
        // Skip NVIDIA / AMD here — nvidia-smi / rocm-smi produce better entries with memory.total
        if vendor == "nvidia" || vendor == "amd" { continue }
        let from_registry = registry_vram
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case(&name))
            .map(|(_, mib)| *mib);
        let (memory_mib, source) = match from_registry {
            Some(mib) => (Some(mib), "registry"),
            // No registry match. A capped AdapterRAM is worse than no number at
            // all, because the app sizes models against it, so only pass a
            // value through when it is safely inside what uint32 can hold.
            None => match ram_bytes {
                Some(b) if b < 4 * 1024 * 1024 * 1024 - 64 * 1024 * 1024 => (Some(b / 1024 / 1024), "wmic"),
                _ => (None, "wmic"),
            },
        };
        gpus.push(DetectedGpu {
            index: idx,
            vendor: vendor.into(),
            name,
            memory_mib,
            source: source.into(),
        });
        idx += 1;
    }
    gpus
}

#[cfg(not(target_os = "windows"))]
fn detect_other_via_wmic() -> Vec<DetectedGpu> { vec![] }

/// Class GUID of the display-adapter registry branch. Every installed GPU
/// driver gets a numbered subkey (0000, 0001, …) under it.
#[allow(dead_code)]
const DISPLAY_CLASS_KEY: &str =
    r"HKLM\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}";

/// Pull `<subkey> → <value>` pairs out of `reg query … /s /v <name>` output.
///
/// The layout is a key line at column 0 followed by indented value lines:
///
/// ```text
/// HKEY_LOCAL_MACHINE\SYSTEM\…\Class\{4d36e968-…}\0000
///     DriverDesc    REG_SZ    Intel(R) Arc(TM) Pro B60 Graphics
/// ```
///
/// Keeping this a pure function over the text means the join below is testable
/// on any platform, which matters because the machine that reproduces the bug
/// is not the machine the tests run on. Value data may contain spaces, so only
/// the name and type columns are split off.
fn parse_reg_query(raw: &str, value_name: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut current: Option<String> = None;
    for line in raw.lines() {
        let trimmed = line.trim_end();
        if trimmed.is_empty() {
            continue;
        }
        if !trimmed.starts_with(char::is_whitespace) {
            // Key line. Remember the leaf ("0000"), which is what the two
            // queries have in common.
            if trimmed.starts_with("HKEY_") {
                current = trimmed.rsplit('\\').next().map(|s| s.to_string());
            } else {
                // "End of search: N match(es) found." and its localized twins.
                current = None;
            }
            continue;
        }
        let Some(key) = current.as_ref() else { continue };
        let mut parts = trimmed.split_whitespace();
        let Some(name) = parts.next() else { continue };
        if !name.eq_ignore_ascii_case(value_name) {
            continue;
        }
        let Some(_reg_type) = parts.next() else { continue };
        // Rejoin: the value itself can hold spaces ("Intel(R) Arc(TM) Pro B60").
        let rest = parts.collect::<Vec<_>>().join(" ");
        if rest.is_empty() {
            continue;
        }
        out.push((key.clone(), rest));
    }
    out
}

/// Parse a REG_QWORD / REG_DWORD payload ("0x600000000") into bytes.
fn parse_reg_hex(value: &str) -> Option<u64> {
    let v = value.trim();
    let hex = v.strip_prefix("0x").or_else(|| v.strip_prefix("0X"))?;
    u64::from_str_radix(hex, 16).ok()
}

/// Adapter name → VRAM in MiB, read from the driver's own registry entry.
///
/// WMI's `AdapterRAM` is a uint32, so it cannot express more than 4 GiB and
/// reports nonsense above it: bobbyt5667's Arc Pro B60 with 24 GB showed up as
/// 2 GB, which is also the card this whole module was written for. The driver
/// writes the true size next to itself as a 64-bit qword, so that is the
/// number we believe whenever it answers.
#[allow(dead_code)]
fn vram_mib_by_adapter_name() -> Vec<(String, u64)> {
    let names = match run_cmd("reg", &["query", DISPLAY_CLASS_KEY, "/s", "/v", "DriverDesc"]) {
        Some(s) => parse_reg_query(&s, "DriverDesc"),
        None => return vec![],
    };
    let sizes = match run_cmd(
        "reg",
        &["query", DISPLAY_CLASS_KEY, "/s", "/v", "HardwareInformation.qwMemorySize"],
    ) {
        Some(s) => parse_reg_query(&s, "HardwareInformation.qwMemorySize"),
        None => return vec![],
    };
    join_name_and_size(&names, &sizes)
}

/// Join the two registry queries on their shared subkey. Split out so the
/// join itself is testable without a registry.
fn join_name_and_size(names: &[(String, String)], sizes: &[(String, String)]) -> Vec<(String, u64)> {
    names
        .iter()
        .filter_map(|(key, name)| {
            let raw = sizes.iter().find(|(k, _)| k == key).map(|(_, v)| v)?;
            let bytes = parse_reg_hex(raw)?;
            if bytes == 0 {
                return None;
            }
            Some((name.trim().to_string(), bytes / 1024 / 1024))
        })
        .collect()
}

#[tauri::command]
pub fn detect_gpus() -> Result<Vec<DetectedGpu>, String> {
    let mut gpus = Vec::new();
    gpus.extend(detect_nvidia());
    gpus.extend(detect_amd());
    gpus.extend(detect_other_via_lspci());
    gpus.extend(detect_other_via_wmic());
    gpus.extend(detect_macos());
    Ok(gpus)
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct GpuSelection {
    /// Vendor whose env-var family to set ("nvidia" | "amd" | "intel" | "auto").
    /// "auto" leaves env-vars unset and lets the runtime pick its default.
    pub vendor: String,
    /// Zero-based, vendor-scoped indices of the GPUs to expose. Empty list
    /// means "all available" (env-var unset).
    pub indices: Vec<u32>,
}

#[tauri::command]
pub fn set_gpu_selection(state: State<'_, AppState>, selection: GpuSelection) -> Result<(), String> {
    let mut sel = state.gpu_selection.lock().map_err(|e| e.to_string())?;
    *sel = selection;
    Ok(())
}

#[tauri::command]
pub fn get_gpu_selection(state: State<'_, AppState>) -> Result<GpuSelection, String> {
    let sel = state.gpu_selection.lock().map_err(|e| e.to_string())?;
    Ok(sel.clone())
}

/// Apply the persisted GPU selection to a Command's env, ahead of `.spawn()`.
/// No-op when vendor is "auto" or indices are empty — the runtime falls back
/// to driver-decided device order, which is the previous (pre-v2.5.0)
/// behaviour.
pub fn apply_gpu_env(cmd: &mut Command, selection: &GpuSelection) {
    if selection.indices.is_empty() { return }
    let csv: String = selection.indices.iter().map(|i| i.to_string()).collect::<Vec<_>>().join(",");
    match selection.vendor.as_str() {
        "nvidia" => { cmd.env("CUDA_VISIBLE_DEVICES", &csv); }
        "amd" => {
            // HIP_VISIBLE_DEVICES is the official ROCm name; ROCR_VISIBLE_DEVICES
            // is the lower-level Runtime equivalent that some older builds
            // honour. Setting both is harmless.
            cmd.env("HIP_VISIBLE_DEVICES", &csv);
            cmd.env("ROCR_VISIBLE_DEVICES", &csv);
        }
        "intel" => {
            // SYCL / oneAPI selector. Format: "level_zero:0,1" or "opencl:0".
            // We default to level_zero which is what Intel's IPEX-LLM uses.
            let sycl: String = selection.indices.iter().map(|i| format!("level_zero:{}", i)).collect::<Vec<_>>().join(",");
            cmd.env("ONEAPI_DEVICE_SELECTOR", &sycl);
        }
        _ => {} // auto / unknown — leave env untouched
    }
}

impl Default for GpuSelection {
    fn default() -> Self {
        GpuSelection { vendor: "auto".into(), indices: vec![] }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real `reg query … /s /v DriverDesc` shape from a two-GPU box: an Arc Pro
    /// alongside a Radeon (bobbyt5667's machine, Discord 2026-07-28).
    const DRIVER_DESC_OUT: &str = r"
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000
    DriverDesc    REG_SZ    Intel(R) Arc(TM) Pro B60 Graphics

HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0001
    DriverDesc    REG_SZ    AMD Radeon RX 6800 XT

End of search: 2 match(es) found.
";

    /// 0x600000000 = 24 GiB, 0x400000000 = 16 GiB.
    const QW_MEMORY_OUT: &str = r"
HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000
    HardwareInformation.qwMemorySize    REG_QWORD    0x600000000

HKEY_LOCAL_MACHINE\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0001
    HardwareInformation.qwMemorySize    REG_QWORD    0x400000000

End of search: 2 match(es) found.
";

    #[test]
    fn parse_reg_query_pairs_each_subkey_with_its_value() {
        let got = parse_reg_query(DRIVER_DESC_OUT, "DriverDesc");
        assert_eq!(
            got,
            vec![
                ("0000".to_string(), "Intel(R) Arc(TM) Pro B60 Graphics".to_string()),
                ("0001".to_string(), "AMD Radeon RX 6800 XT".to_string()),
            ]
        );
    }

    #[test]
    fn parse_reg_query_ignores_the_trailing_summary_line() {
        // "End of search: …" sits at column 0 but is not a key, so it must not
        // become one and swallow the next value.
        let got = parse_reg_query(DRIVER_DESC_OUT, "DriverDesc");
        assert!(got.iter().all(|(k, _)| k == "0000" || k == "0001"));
    }

    #[test]
    fn parse_reg_query_skips_other_value_names() {
        assert!(parse_reg_query(DRIVER_DESC_OUT, "HardwareInformation.qwMemorySize").is_empty());
    }

    #[test]
    fn parse_reg_hex_reads_qword_payloads() {
        assert_eq!(parse_reg_hex("0x600000000"), Some(25_769_803_776));
        assert_eq!(parse_reg_hex("  0x400000000 "), Some(17_179_869_184));
        assert_eq!(parse_reg_hex("24 GB"), None);
    }

    /// The bug: WMI's uint32 AdapterRAM reported 2 GB for a 24 GB Arc Pro B60.
    /// The registry qword has the real number, and that is what we join on.
    #[test]
    fn join_recovers_the_true_size_of_a_card_larger_than_uint32() {
        let names = parse_reg_query(DRIVER_DESC_OUT, "DriverDesc");
        let sizes = parse_reg_query(QW_MEMORY_OUT, "HardwareInformation.qwMemorySize");
        let joined = join_name_and_size(&names, &sizes);
        assert_eq!(
            joined,
            vec![
                ("Intel(R) Arc(TM) Pro B60 Graphics".to_string(), 24576),
                ("AMD Radeon RX 6800 XT".to_string(), 16384),
            ]
        );
    }

    #[test]
    fn join_drops_adapters_without_a_size_and_zero_sized_ones() {
        let names = vec![
            ("0000".to_string(), "Intel(R) Arc(TM) Pro B60 Graphics".to_string()),
            ("0001".to_string(), "Microsoft Basic Display Adapter".to_string()),
            ("0002".to_string(), "Some Virtual Adapter".to_string()),
        ];
        let sizes = vec![
            ("0000".to_string(), "0x600000000".to_string()),
            ("0002".to_string(), "0x0".to_string()),
        ];
        let joined = join_name_and_size(&names, &sizes);
        assert_eq!(joined, vec![("Intel(R) Arc(TM) Pro B60 Graphics".to_string(), 24576)]);
    }

    #[test]
    fn apply_gpu_env_sets_cuda_for_nvidia() {
        let sel = GpuSelection { vendor: "nvidia".into(), indices: vec![1, 2] };
        let mut cmd = Command::new("echo");
        apply_gpu_env(&mut cmd, &sel);
        // We can inspect envs via get_envs (Rust 1.69+).
        let has_cuda = cmd.get_envs().any(|(k, v)| k == "CUDA_VISIBLE_DEVICES" && v.map(|s| s == "1,2").unwrap_or(false));
        assert!(has_cuda, "CUDA_VISIBLE_DEVICES should be set to 1,2");
    }

    #[test]
    fn apply_gpu_env_sets_hip_and_rocr_for_amd() {
        let sel = GpuSelection { vendor: "amd".into(), indices: vec![0] };
        let mut cmd = Command::new("echo");
        apply_gpu_env(&mut cmd, &sel);
        let hip = cmd.get_envs().any(|(k, v)| k == "HIP_VISIBLE_DEVICES" && v.map(|s| s == "0").unwrap_or(false));
        let rocr = cmd.get_envs().any(|(k, v)| k == "ROCR_VISIBLE_DEVICES" && v.map(|s| s == "0").unwrap_or(false));
        assert!(hip, "HIP_VISIBLE_DEVICES should be set");
        assert!(rocr, "ROCR_VISIBLE_DEVICES should be set");
    }

    #[test]
    fn apply_gpu_env_sets_oneapi_for_intel() {
        let sel = GpuSelection { vendor: "intel".into(), indices: vec![0, 1] };
        let mut cmd = Command::new("echo");
        apply_gpu_env(&mut cmd, &sel);
        let sycl = cmd.get_envs().any(|(k, v)| k == "ONEAPI_DEVICE_SELECTOR" && v.map(|s| s == "level_zero:0,level_zero:1").unwrap_or(false));
        assert!(sycl, "ONEAPI_DEVICE_SELECTOR should be set to level_zero:0,level_zero:1");
    }

    #[test]
    fn apply_gpu_env_is_noop_when_auto() {
        let sel = GpuSelection { vendor: "auto".into(), indices: vec![1] };
        let mut cmd = Command::new("echo");
        apply_gpu_env(&mut cmd, &sel);
        // "auto" doesn't match any vendor branch — env should be empty (no GPU vars)
        let any_gpu_env = cmd.get_envs().any(|(k, _)| {
            let key = k.to_string_lossy().to_string();
            key.contains("VISIBLE_DEVICES") || key == "ONEAPI_DEVICE_SELECTOR"
        });
        assert!(!any_gpu_env, "auto vendor must not set any GPU env-var");
    }

    #[test]
    fn apply_gpu_env_is_noop_when_indices_empty() {
        let sel = GpuSelection { vendor: "nvidia".into(), indices: vec![] };
        let mut cmd = Command::new("echo");
        apply_gpu_env(&mut cmd, &sel);
        let any_gpu_env = cmd.get_envs().any(|(k, _)| {
            let key = k.to_string_lossy().to_string();
            key.contains("VISIBLE_DEVICES") || key == "ONEAPI_DEVICE_SELECTOR"
        });
        assert!(!any_gpu_env, "empty indices must not set any GPU env-var");
    }
}
