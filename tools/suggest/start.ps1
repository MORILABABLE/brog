# サジェスト調査の画面を開く（デスクトップのショートカットから呼ばれる）。
#
#   - サーバーが動いていなければ、別ウィンドウで `npm run suggest:ui` を起動する
#   - 立ち上がるのを待ってから、既定のブラウザで開く
#   - もう動いていれば、ブラウザで開くだけ（二重に起動しない）
#
# サーバーを止めるときは「サジェスト調査サーバー」のウィンドウを閉じる。
# ショートカットを作り直すときは add-desktop-shortcut.ps1 を実行する。
#
# ★ このファイルは UTF-8（BOM 付き）で保存すること。
#   Windows PowerShell 5.1 は BOM の無い UTF-8 を ANSI として読み、日本語の文字列が化ける。
param(
  # 動作確認用。サーバーの起動までを行い、ブラウザは開かない
  [switch]$NoBrowser,
  # 既定は server.ts と同じ 5178。動いているサーバーに触らずに確かめるときに変える
  [int]$Port = 5178
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$url = "http://127.0.0.1:$Port"

function Test-Server {
  try {
    Invoke-WebRequest -Uri "$url/api/config" -UseBasicParsing -TimeoutSec 2 | Out-Null
    return $true
  } catch {
    return $false
  }
}

if (-not (Test-Server)) {
  # 失敗したときに理由が読めるよう、異常終了したら pause で窓を残す
  Start-Process -FilePath 'cmd.exe' -WorkingDirectory $root `
    -ArgumentList '/c', "title サジェスト調査サーバー（閉じると止まります） && npm run suggest:ui -- --port $Port || pause"

  $deadline = (Get-Date).AddSeconds(40)
  while (-not (Test-Server)) {
    if ((Get-Date) -gt $deadline) {
      Add-Type -AssemblyName PresentationFramework
      [void][System.Windows.MessageBox]::Show(
        "サーバーが40秒たっても起動しませんでした。`n「サジェスト調査サーバー」のウィンドウに出ている内容を確認してください。",
        'サジェスト調査')
      exit 1
    }
    Start-Sleep -Milliseconds 500
  }
}

if (-not $NoBrowser) {
  Start-Process $url
}
