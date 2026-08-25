# Запуск дашборда в Windows: .\start.ps1
# Поднимает сервер и открывает браузер. Ctrl+C — остановить.

$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Host "Node.js не найден. Установите LTS с https://nodejs.org и запустите снова." -ForegroundColor Red
  exit 1
}

$version = (node -v) -replace '^v', ''
if ([int]($version.Split('.')[0]) -lt 18) {
  Write-Host "Нужен Node.js 18 или новее (сейчас v$version)." -ForegroundColor Red
  exit 1
}

$port = if ($env:PORT) { $env:PORT } else { '5173' }

Write-Host ""
Write-Host "  Transfer Tracker" -ForegroundColor Cyan
Write-Host "  http://127.0.0.1:$port"
Write-Host ""
Write-Host "  Живые данные требуют запущенного transfermarkt-api на localhost:8000." -ForegroundColor DarkGray
Write-Host "  Если его нет — сайт откроется на офлайн-срезе." -ForegroundColor DarkGray
Write-Host ""

Start-Job -ScriptBlock {
  Start-Sleep -Seconds 2
  Start-Process "http://127.0.0.1:$using:port"
} | Out-Null

node server.js
