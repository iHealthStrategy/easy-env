// Skill management: copies the bundled `easy-env-bootstrap.md` (and any other
// .md under packages/mcp-server/skills) into ~/.claude/skills/. Replaces the
// standalone `easy-env-install-skill.mjs` CLI — same behavior, called via a
// Tauri command instead.
//
// Claude Code's current skill format is one DIRECTORY per skill containing a
// SKILL.md file. We map each `<name>.md` in the source dir onto
// `<target>/<name>/SKILL.md`, and clean up any legacy loose .md left over
// from older installer versions.

use crate::paths;
use anyhow::{Context, Result};
use serde::Serialize;
use std::fs;
use std::path::PathBuf;

#[derive(Debug, Serialize, Clone)]
pub struct SkillEntry {
    pub name: String,
    pub installed: bool,
    pub source_size: u64,
    pub target_size: Option<u64>,
    pub target_path: String,
    pub up_to_date: bool,
}

#[derive(Debug, Serialize, Clone)]
pub struct SkillStatus {
    pub source_dir: String,
    pub target_dir: String,
    pub entries: Vec<SkillEntry>,
    pub all_installed: bool,
}

/// Map `<source_dir>/<name>.md` to `<target_root>/<name>/SKILL.md`.
fn target_path_for(target_root: &PathBuf, source_filename: &str) -> PathBuf {
    let stem = source_filename.trim_end_matches(".md");
    target_root.join(stem).join("SKILL.md")
}

pub fn status() -> Result<SkillStatus> {
    let info = paths::info()?;
    let source = PathBuf::from(&info.skill_source_dir);
    let target = PathBuf::from(&info.claude_skills_dir);

    let mut entries = Vec::new();
    if source.exists() {
        for dirent in fs::read_dir(&source)
            .with_context(|| format!("read_dir {}", source.display()))?
        {
            let dirent = dirent?;
            let p = dirent.path();
            if !p.is_file() {
                continue;
            }
            if p.extension().map_or(true, |e| e != "md") {
                continue;
            }
            let name = p.file_name().unwrap().to_string_lossy().to_string();
            let src_meta = fs::metadata(&p)?;
            let dst = target_path_for(&target, &name);
            let dst_meta = fs::metadata(&dst).ok();
            let installed = dst_meta.is_some();
            let target_size = dst_meta.as_ref().map(|m| m.len());
            let up_to_date = target_size == Some(src_meta.len());
            entries.push(SkillEntry {
                name,
                installed,
                source_size: src_meta.len(),
                target_size,
                target_path: dst.display().to_string(),
                up_to_date,
            });
        }
    }

    let all_installed = !entries.is_empty() && entries.iter().all(|e| e.installed && e.up_to_date);
    Ok(SkillStatus {
        source_dir: source.display().to_string(),
        target_dir: target.display().to_string(),
        entries,
        all_installed,
    })
}

pub fn install() -> Result<()> {
    let info = paths::info()?;
    let source = PathBuf::from(&info.skill_source_dir);
    let target = PathBuf::from(&info.claude_skills_dir);
    paths::ensure_dir(&target)?;

    if !source.exists() {
        anyhow::bail!("skill source dir not found: {}", source.display());
    }

    let mut copied = 0;
    for dirent in fs::read_dir(&source)? {
        let p = dirent?.path();
        if !p.is_file() || p.extension().map_or(true, |e| e != "md") {
            continue;
        }
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let dst = target_path_for(&target, &name);
        if let Some(parent) = dst.parent() {
            paths::ensure_dir(parent)?;
        }
        fs::copy(&p, &dst)
            .with_context(|| format!("copy {} -> {}", p.display(), dst.display()))?;
        copied += 1;

        // Remove legacy loose .md (pre-directory-format) if it exists.
        let legacy = target.join(&name);
        if legacy.is_file() {
            let _ = fs::remove_file(&legacy);
        }
    }
    if copied == 0 {
        anyhow::bail!("no .md skills found in {}", source.display());
    }
    Ok(())
}

pub fn uninstall() -> Result<()> {
    let info = paths::info()?;
    let source = PathBuf::from(&info.skill_source_dir);
    let target = PathBuf::from(&info.claude_skills_dir);
    if !source.exists() || !target.exists() {
        return Ok(());
    }
    for dirent in fs::read_dir(&source)? {
        let p = dirent?.path();
        if !p.is_file() || p.extension().map_or(true, |e| e != "md") {
            continue;
        }
        let name = p.file_name().unwrap().to_string_lossy().to_string();
        let stem = name.trim_end_matches(".md");
        let dir = target.join(stem);
        if dir.is_dir() {
            let _ = fs::remove_dir_all(&dir);
        }
        // Also clean up any legacy loose .md form.
        let legacy = target.join(&name);
        if legacy.is_file() {
            let _ = fs::remove_file(&legacy);
        }
    }
    Ok(())
}
