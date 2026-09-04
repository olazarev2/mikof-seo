<#
.SYNOPSIS
  Проверка исполнения ТЗ по SEO-техдолгу mikof.md.
.DESCRIPTION
  Обёртка над verify/verify.mjs: бьёт по живому сайту и показывает, какие из 22 задач
  реально выполнены. Отчёт сохраняется в verify\reports\ГГГГ-ММ-ДД.md.
.EXAMPLE
  .\Verify-Seo.ps1
  .\Verify-Seo.ps1 -Fast
  .\Verify-Seo.ps1 -Only A1,A5
#>
[CmdletBinding()]
param(
  [switch]$Fast,
  [string[]]$Only
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Нужен Node.js 18+. Скачать: https://nodejs.org"
}

$script = Join-Path $PSScriptRoot 'verify.mjs'
$argsList = @($script)
if ($Fast) { $argsList += '--no-psi' }
if ($Only) { $argsList += @('--only', ($Only -join ',')) }

& node @argsList
