use atomic_write_file::AtomicWriteFile;
use chardetng::{EncodingDetector, Iso2022JpDetection, Utf8Detection};
use encoding_rs::{UTF_16BE, UTF_16LE};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
    pub path: String,
    pub content: String,
    pub hash: String,
    pub line_ending: String,
    pub bom: bool,
    pub read_only: bool,
    pub detected_encoding: String,
    pub modified_at_ms: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentRequest {
    pub path: String,
    pub content: String,
    pub expected_hash: Option<String>,
    pub line_ending: String,
    pub bom: bool,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDocumentResult {
    pub status: String,
    pub hash: String,
    pub modified_at_ms: u64,
    pub disk_document: Option<DocumentPayload>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub content: String,
    pub conflicted: bool,
}

pub fn read_document(path: &Path) -> Result<DocumentPayload, String> {
    let bytes = fs::read(path).map_err(|error| format!("문서를 읽을 수 없습니다: {error}"))?;
    let metadata =
        fs::metadata(path).map_err(|error| format!("문서 정보를 읽을 수 없습니다: {error}"))?;
    let decoded = decode_document(&bytes);
    let line_ending = detect_line_ending(&decoded.content);
    let content = normalize_newlines(&decoded.content);
    let modified_at_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as u64)
        .unwrap_or_default();

    Ok(DocumentPayload {
        path: absolute_display_path(path),
        content,
        hash: hash_bytes(&bytes),
        line_ending: line_ending.to_string(),
        bom: decoded.bom,
        read_only: decoded.legacy_encoding || is_filesystem_read_only(&metadata),
        detected_encoding: decoded.encoding,
        modified_at_ms,
    })
}

pub fn save_document(request: &SaveDocumentRequest) -> Result<SaveDocumentResult, String> {
    let path = absolute_path(&request.path)?;
    if path.is_dir() {
        return Err("폴더에는 원고를 저장할 수 없습니다.".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("저장 폴더를 만들 수 없습니다: {error}"))?;
    }

    if path.exists() {
        let disk_bytes =
            fs::read(&path).map_err(|error| format!("기존 문서를 확인할 수 없습니다: {error}"))?;
        let disk_hash = hash_bytes(&disk_bytes);
        let hash_matches = request
            .expected_hash
            .as_ref()
            .is_some_and(|expected| expected == &disk_hash);
        if !request.force && !hash_matches {
            return Ok(SaveDocumentResult {
                status: "conflict".to_string(),
                hash: disk_hash,
                modified_at_ms: 0,
                disk_document: Some(read_document(&path)?),
            });
        }
    } else if request.expected_hash.is_some() && !request.force {
        return Err("원본 파일이 사라졌습니다. 새 파일로 저장할지 확인해주세요.".to_string());
    }

    let bytes = encode_document(&request.content, &request.line_ending, request.bom);
    let mut file = AtomicWriteFile::open(&path)
        .map_err(|error| format!("임시 저장 파일을 만들 수 없습니다: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("원고를 기록할 수 없습니다: {error}"))?;
    file.commit()
        .map_err(|error| format!("원고를 원자적으로 교체할 수 없습니다: {error}"))?;

    let saved = read_document(&path)?;
    Ok(SaveDocumentResult {
        status: "saved".to_string(),
        hash: saved.hash,
        modified_at_ms: saved.modified_at_ms,
        disk_document: None,
    })
}

pub fn convert_document_to_utf8(path: &Path) -> Result<DocumentPayload, String> {
    let current = read_document(path)?;
    let request = SaveDocumentRequest {
        path: current.path.clone(),
        content: current.content,
        expected_hash: Some(current.hash),
        line_ending: current.line_ending,
        bom: false,
        force: false,
    };
    save_document(&request)?;
    read_document(path)
}

pub fn merge_three_way(base: &str, local: &str, remote: &str) -> MergeResult {
    if local == remote {
        return MergeResult {
            content: local.to_string(),
            conflicted: false,
        };
    }
    if local == base {
        return MergeResult {
            content: remote.to_string(),
            conflicted: false,
        };
    }
    if remote == base {
        return MergeResult {
            content: local.to_string(),
            conflicted: false,
        };
    }

    match diffy::merge(base, local, remote) {
        Ok(content) => MergeResult {
            content,
            conflicted: false,
        },
        Err(content) => MergeResult {
            content,
            conflicted: true,
        },
    }
}

pub fn hash_text(value: &str) -> String {
    hash_bytes(value.as_bytes())
}

fn hash_bytes(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn absolute_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.is_absolute() {
        return Err("문서 경로는 절대경로여야 합니다.".to_string());
    }
    Ok(path)
}

fn absolute_display_path(path: &Path) -> String {
    path.canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .to_string()
}

struct DecodedDocument {
    content: String,
    encoding: String,
    bom: bool,
    legacy_encoding: bool,
}

fn decode_document(bytes: &[u8]) -> DecodedDocument {
    if let Some(value) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return DecodedDocument {
            content: String::from_utf8_lossy(value).into_owned(),
            encoding: "UTF-8".to_string(),
            bom: true,
            legacy_encoding: false,
        };
    }
    if let Some(value) = bytes.strip_prefix(&[0xFF, 0xFE]) {
        let (content, _, _) = UTF_16LE.decode(value);
        return DecodedDocument {
            content: content.into_owned(),
            encoding: "UTF-16LE".to_string(),
            bom: true,
            legacy_encoding: true,
        };
    }
    if let Some(value) = bytes.strip_prefix(&[0xFE, 0xFF]) {
        let (content, _, _) = UTF_16BE.decode(value);
        return DecodedDocument {
            content: content.into_owned(),
            encoding: "UTF-16BE".to_string(),
            bom: true,
            legacy_encoding: true,
        };
    }
    if let Ok(content) = std::str::from_utf8(bytes) {
        return DecodedDocument {
            content: content.to_string(),
            encoding: "UTF-8".to_string(),
            bom: false,
            legacy_encoding: false,
        };
    }

    let mut detector = EncodingDetector::new(Iso2022JpDetection::Allow);
    detector.feed(bytes, true);
    let encoding = detector.guess(None, Utf8Detection::Allow);
    let (content, _, _) = encoding.decode(bytes);
    DecodedDocument {
        content: content.into_owned(),
        encoding: encoding.name().to_string(),
        bom: false,
        legacy_encoding: true,
    }
}

fn encode_document(content: &str, line_ending: &str, bom: bool) -> Vec<u8> {
    let normalized = normalize_newlines(content);
    let rendered = if line_ending == "CRLF" {
        normalized.replace('\n', "\r\n")
    } else {
        normalized
    };
    let mut bytes = Vec::with_capacity(rendered.len() + usize::from(bom) * 3);
    if bom {
        bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    }
    bytes.extend_from_slice(rendered.as_bytes());
    bytes
}

fn detect_line_ending(content: &str) -> &'static str {
    if content.contains("\r\n") {
        "CRLF"
    } else {
        "LF"
    }
}

fn normalize_newlines(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn is_filesystem_read_only(metadata: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o222 == 0
    }
    #[cfg(not(unix))]
    {
        metadata.permissions().readonly()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use tempfile::tempdir;

    #[test]
    fn preserves_bom_and_crlf_during_round_trip() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("원고.md");
        fs::write(&path, b"\xEF\xBB\xBF# title\r\n\r\nbody\r\n").unwrap();

        let opened = read_document(&path).unwrap();
        assert_eq!(opened.content, "# title\n\nbody\n");
        assert_eq!(opened.line_ending, "CRLF");
        assert!(opened.bom);

        let result = save_document(&SaveDocumentRequest {
            path: opened.path,
            content: opened.content,
            expected_hash: Some(opened.hash),
            line_ending: opened.line_ending,
            bom: opened.bom,
            force: false,
        })
        .unwrap();
        assert_eq!(result.status, "saved");
        assert_eq!(
            fs::read(&path).unwrap(),
            b"\xEF\xBB\xBF# title\r\n\r\nbody\r\n"
        );
    }

    #[test]
    fn rejects_a_stale_save_and_returns_disk_version() {
        let directory = tempdir().unwrap();
        let path = directory.path().join("draft.md");
        fs::write(&path, "base").unwrap();
        let opened = read_document(&path).unwrap();
        fs::write(&path, "remote").unwrap();

        let result = save_document(&SaveDocumentRequest {
            path: opened.path,
            content: "local".to_string(),
            expected_hash: Some(opened.hash),
            line_ending: "LF".to_string(),
            bom: false,
            force: false,
        })
        .unwrap();

        assert_eq!(result.status, "conflict");
        assert_eq!(result.disk_document.unwrap().content, "remote");
        assert_eq!(fs::read_to_string(path).unwrap(), "remote");
    }

    #[test]
    fn merges_non_overlapping_changes() {
        let merged = merge_three_way("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n");
        assert!(!merged.conflicted);
        assert_eq!(merged.content, "A\nb\nC\n");
    }
}
