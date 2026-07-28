# Linux 설치물

이 폴더에는 로컬에서 검증한 Linux x64 설치물이 생성됩니다. 설치 바이너리는
Git 저장소에 커밋하지 않고
[GitHub Releases](https://github.com/tain030/research-writer/releases/latest)에
첨부합니다.

```bash
pnpm tauri build --bundles deb,appimage
```

- `.deb`: Debian/Ubuntu 계열에서 설치
- `.AppImage`: 실행 권한을 준 뒤 대부분의 x86_64 Linux 데스크톱에서 직접 실행

설치물은 로컬 개발 빌드이며 공개 배포용 서명이 적용되지 않았습니다. 파일별
SHA-256 값은 같은 폴더의 `SHA256SUMS`에서 확인할 수 있습니다.

다른 노트북에서는 최신 Release에서 `.deb`와 `SHA256SUMS`를 내려받아
설치합니다.

```bash
cd ~/Downloads
grep 'research-writer_0.1.1_amd64.deb$' SHA256SUMS | sha256sum -c -
sudo apt install ./research-writer_0.1.1_amd64.deb
```
