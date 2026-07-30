use crate::database::MetadataDb;
use crate::manuscript;
use base64::Engine;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use uuid::Uuid;

const MAX_ASSET_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedAsset {
    pub relative_path: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManuscriptAssetData {
    pub relative_path: String,
    pub file_name: String,
    pub mime_type: String,
    pub size_bytes: u64,
    pub data_url: String,
}

pub fn import_asset(
    db: &MetadataDb,
    document_path: &str,
    source_path: &str,
) -> Result<ImportedAsset, String> {
    let document = canonical_document(document_path)?;
    let source = PathBuf::from(source_path.trim())
        .canonicalize()
        .map_err(|error| format!("그림 파일을 확인할 수 없습니다: {error}"))?;
    let (extension, mime_type) = supported_image(&source)?;
    let metadata =
        fs::metadata(&source).map_err(|error| format!("그림 정보를 읽을 수 없습니다: {error}"))?;
    if !metadata.is_file() {
        return Err("선택한 그림이 일반 파일이 아닙니다.".to_string());
    }
    validate_size(metadata.len())?;
    validate_image_signature(&source, mime_type)?;

    let parent = document
        .parent()
        .ok_or_else(|| "원고 폴더를 확인할 수 없습니다.".to_string())?;
    let assets = parent.join("assets");
    ensure_asset_directory(parent, &assets)?;
    let file_name = format!("{}.{}", Uuid::new_v4(), extension);
    let destination = assets.join(&file_name);
    copy_atomically(&source, &destination)?;

    let relative_path = format!("assets/{file_name}");
    let imported = ImportedAsset {
        relative_path,
        file_name,
        mime_type: mime_type.to_string(),
        size_bytes: metadata.len(),
    };
    validate_asset_scope(db, &document, Path::new(&imported.relative_path))?;
    Ok(imported)
}

pub fn read_asset(
    db: &MetadataDb,
    document_path: &str,
    relative_path: &str,
) -> Result<ManuscriptAssetData, String> {
    let document = canonical_document(document_path)?;
    let requested = validate_relative_path(relative_path)?;
    let asset = validate_asset_scope(db, &document, &requested)?;
    let (_, mime_type) = supported_image(&asset)?;
    let metadata =
        fs::metadata(&asset).map_err(|error| format!("그림 정보를 읽을 수 없습니다: {error}"))?;
    if !metadata.is_file() {
        return Err("그림 경로가 일반 파일이 아닙니다.".to_string());
    }
    validate_size(metadata.len())?;
    validate_image_signature(&asset, mime_type)?;

    let mut file =
        fs::File::open(&asset).map_err(|error| format!("그림을 열 수 없습니다: {error}"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("그림을 읽을 수 없습니다: {error}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(ManuscriptAssetData {
        relative_path: relative_path.replace('\\', "/"),
        file_name: asset
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("asset")
            .to_string(),
        mime_type: mime_type.to_string(),
        size_bytes: metadata.len(),
        data_url: format!("data:{mime_type};base64,{encoded}"),
    })
}

fn canonical_document(path: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(path.trim());
    if !path.is_absolute() || !is_markdown(&path) {
        return Err("원고는 .md 또는 .markdown 절대경로여야 합니다.".to_string());
    }
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("원고 경로를 확인할 수 없습니다: {error}"))?;
    if !canonical.is_file() {
        return Err("원고 파일을 찾을 수 없습니다.".to_string());
    }
    Ok(canonical)
}

fn validate_relative_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value.trim());
    if path.as_os_str().is_empty() || path.is_absolute() {
        return Err("그림은 원고 기준 상대경로여야 합니다.".to_string());
    }
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err("그림 경로가 원고 폴더를 벗어날 수 없습니다.".to_string());
    }
    Ok(path)
}

fn validate_asset_scope(
    db: &MetadataDb,
    document: &Path,
    relative_path: &Path,
) -> Result<PathBuf, String> {
    let document_parent = document
        .parent()
        .ok_or_else(|| "원고 폴더를 확인할 수 없습니다.".to_string())?
        .canonicalize()
        .map_err(|error| format!("원고 폴더를 확인할 수 없습니다: {error}"))?;
    let repository_root = manuscript::repository_status(db)
        .ok()
        .filter(|status| status.available)
        .and_then(|status| status.path)
        .map(PathBuf::from)
        .and_then(|path| path.canonicalize().ok())
        .filter(|root| document.starts_with(root));
    let allowed_root = repository_root.as_deref().unwrap_or(&document_parent);
    let candidate = document_parent.join(relative_path);
    let canonical = candidate
        .canonicalize()
        .map_err(|error| format!("그림 경로를 확인할 수 없습니다: {error}"))?;
    if !canonical.starts_with(allowed_root) {
        return Err("그림 경로가 열린 저장소 또는 원고 폴더를 벗어납니다.".to_string());
    }
    Ok(canonical)
}

fn ensure_asset_directory(parent: &Path, assets: &Path) -> Result<(), String> {
    if assets.exists() {
        let metadata = fs::symlink_metadata(assets)
            .map_err(|error| format!("assets 폴더를 확인할 수 없습니다: {error}"))?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err("assets 경로는 심볼릭 링크가 아닌 폴더여야 합니다.".to_string());
        }
    } else {
        fs::create_dir(assets)
            .map_err(|error| format!("assets 폴더를 만들 수 없습니다: {error}"))?;
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|error| format!("원고 폴더를 확인할 수 없습니다: {error}"))?;
    let canonical_assets = assets
        .canonicalize()
        .map_err(|error| format!("assets 폴더를 확인할 수 없습니다: {error}"))?;
    if !canonical_assets.starts_with(canonical_parent) {
        return Err("assets 폴더가 원고 폴더를 벗어납니다.".to_string());
    }
    Ok(())
}

fn copy_atomically(source: &Path, destination: &Path) -> Result<(), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "그림 저장 폴더를 확인할 수 없습니다.".to_string())?;
    let temporary = parent.join(format!(".{}.importing", Uuid::new_v4()));
    let result = (|| {
        let mut input =
            fs::File::open(source).map_err(|error| format!("그림을 열 수 없습니다: {error}"))?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
            .map_err(|error| format!("임시 그림 파일을 만들 수 없습니다: {error}"))?;
        std::io::copy(&mut input, &mut output)
            .map_err(|error| format!("그림을 복사할 수 없습니다: {error}"))?;
        output
            .flush()
            .and_then(|_| output.sync_all())
            .map_err(|error| format!("그림을 디스크에 기록할 수 없습니다: {error}"))?;
        fs::rename(&temporary, destination)
            .map_err(|error| format!("그림을 저장할 수 없습니다: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn supported_image(path: &Path) -> Result<(&'static str, &'static str), String> {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Ok(("png", "image/png")),
        "jpg" | "jpeg" => Ok(("jpg", "image/jpeg")),
        "webp" => Ok(("webp", "image/webp")),
        "gif" => Ok(("gif", "image/gif")),
        _ => Err("그림은 PNG, JPEG, WebP 또는 GIF 파일이어야 합니다.".to_string()),
    }
}

fn validate_size(size: u64) -> Result<(), String> {
    if size == 0 {
        return Err("빈 그림 파일은 삽입할 수 없습니다.".to_string());
    }
    if size > MAX_ASSET_BYTES {
        return Err("그림 파일은 20MiB 이하여야 합니다.".to_string());
    }
    Ok(())
}

fn validate_image_signature(path: &Path, mime_type: &str) -> Result<(), String> {
    let mut file =
        fs::File::open(path).map_err(|error| format!("그림을 열 수 없습니다: {error}"))?;
    let mut header = [0_u8; 12];
    let count = file
        .read(&mut header)
        .map_err(|error| format!("그림 형식을 확인할 수 없습니다: {error}"))?;
    if valid_image_signature(&header[..count], mime_type) {
        Ok(())
    } else {
        Err("파일 확장자와 실제 그림 형식이 일치하지 않습니다.".to_string())
    }
}

fn valid_image_signature(header: &[u8], mime_type: &str) -> bool {
    match mime_type {
        "image/png" => header.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => header.starts_with(b"\xff\xd8\xff"),
        "image/gif" => header.starts_with(b"GIF87a") || header.starts_with(b"GIF89a"),
        "image/webp" => {
            header.len() >= 12 && header.starts_with(b"RIFF") && &header[8..12] == b"WEBP"
        }
        _ => false,
    }
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| matches!(value.to_ascii_lowercase().as_str(), "md" | "markdown"))
}

#[cfg(test)]
mod tests {
    use super::{supported_image, valid_image_signature, validate_relative_path, validate_size};
    use std::path::Path;

    #[test]
    fn accepts_only_safe_relative_asset_paths() {
        assert!(validate_relative_path("assets/figure.png").is_ok());
        assert!(validate_relative_path("../secret.png").is_err());
        assert!(validate_relative_path("/tmp/secret.png").is_err());
    }

    #[test]
    fn accepts_supported_raster_formats() {
        assert_eq!(
            supported_image(Path::new("figure.PNG")).unwrap(),
            ("png", "image/png")
        );
        assert!(supported_image(Path::new("figure.svg")).is_err());
    }

    #[test]
    fn enforces_asset_size_bounds() {
        assert!(validate_size(1).is_ok());
        assert!(validate_size(0).is_err());
        assert!(validate_size(20 * 1024 * 1024 + 1).is_err());
    }

    #[test]
    fn validates_image_signatures_instead_of_trusting_extensions() {
        assert!(valid_image_signature(b"\x89PNG\r\n\x1a\nrest", "image/png"));
        assert!(valid_image_signature(b"GIF89a-rest", "image/gif"));
        assert!(valid_image_signature(b"RIFF1234WEBP", "image/webp"));
        assert!(!valid_image_signature(b"<script>", "image/png"));
    }
}
