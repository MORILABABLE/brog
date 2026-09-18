# デスクトップに「サジェスト調査」のショートカットを作る（作り直しにも使う）。
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\suggest\add-desktop-shortcut.ps1
#
# ショートカットは start.ps1 を呼ぶだけ。サーバーの起動とブラウザを開くのはそちらの仕事。
# ★ パスはこのファイルの場所から組み立てる。リポジトリは公開なので、個人のパスを書かない。
# ★ UTF-8（BOM 付き）で保存すること（start.ps1 と同じ理由）。

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$starter = Join-Path $PSScriptRoot 'start.ps1'
# OneDrive でデスクトップが移されていても、実際の場所を返す
$desktop = [Environment]::GetFolderPath('Desktop')
$path = Join-Path $desktop 'サジェスト調査.lnk'

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($path)
$link.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
# 起動待ちのあいだ PowerShell の窓を出さない（サーバーの窓は別に開く）
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$starter`""
$link.WorkingDirectory = $root
$link.IconLocation = (Join-Path $env:SystemRoot 'System32\shell32.dll') + ',22'
$link.WindowStyle = 7
$link.Description = 'サジェスト調査の画面を開く（サーバーが止まっていれば起動する）'
$link.Save()

Write-Output "作成しました: $path"
