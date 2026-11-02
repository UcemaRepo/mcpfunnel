@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ============================================================
rem conciliacion.bat - leads de Salesforce vs. leads en sesion
rem ============================================================
rem Llama a GET /conciliacion, guarda la respuesta completa en un
rem .json y muestra el resumen.
rem
rem Uso:
rem   conciliacion.bat                      compara desde 2026-01-01
rem   conciliacion.bat 2026-03-01           compara desde esa fecha
rem   conciliacion.bat 2026-03-01 resumen   sin el detalle de faltantes
rem
rem El token NO se guarda en este archivo. Se toma de la variable
rem de entorno MCP_TOKEN o se pide al ejecutar. Para no tipearlo
rem cada vez:  setx MCP_TOKEN "tu_token"  (y abrir otra consola).
rem ============================================================

if not defined API_URL set "API_URL=https://mcpfunnel.onrender.com"

if not defined MCP_TOKEN (
  set /p "MCP_TOKEN=Token (MCP_TOKEN): "
)
if not defined MCP_TOKEN (
  echo Falta el token.
  exit /b 1
)

set "DESDE=%~1"
if "%DESDE%"=="" set "DESDE=2026-01-01"

set "DETALLE=true"
if /i "%~2"=="resumen" set "DETALLE=false"

for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"
set "SALIDA=conciliacion-%STAMP%.json"

echo.
echo Consultando %API_URL%/conciliacion desde %DESDE% ...
echo (si el servicio estaba dormido puede tardar ~1 minuto)
echo.

curl -sS --max-time 300 ^
  -H "Authorization: Bearer %MCP_TOKEN%" ^
  -H "Accept: application/json" ^
  -o "%SALIDA%" -w "HTTP %%{http_code}\n" ^
  "%API_URL%/conciliacion?desde=%DESDE%&incluirDetalle=%DETALLE%"

if errorlevel 1 (
  echo No se pudo conectar con el servidor.
  exit /b 1
)

powershell -NoProfile -Command ^
  "$t = [string](Get-Content -Raw -Encoding UTF8 -ErrorAction SilentlyContinue '%SALIDA%');" ^
  "if ($t -match 'Just a moment') { Write-Host 'Cloudflare bloqueo el pedido (pagina de desafio). Proba de nuevo en unos minutos o desde otra red.'; exit 2 }" ^
  "if (-not $t.Trim()) { Write-Host 'Respuesta vacia: token incorrecto (el servidor responde 404 sin cuerpo).'; exit 3 }" ^
  "try { $r = $t | ConvertFrom-Json } catch { Write-Host 'La respuesta no es JSON:'; Write-Host $t.Substring(0, [Math]::Min(500, $t.Length)); exit 4 }" ^
  "if (-not $r.ok) { Write-Host ('Error: ' + $r.error); if ($r.error -match 'cargar') { Write-Host 'Hace falta cargar la sesion primero (POST /cargar).' }; exit 5 }" ^
  "Write-Host '';" ^
  "Write-Host ('Estado:                 ' + $r.estado);" ^
  "Write-Host ('Desde:                  ' + $r.alcance.desde);" ^
  "Write-Host ('Sesion cargada en:      ' + $r.cargadoEn);" ^
  "Write-Host ('Leads en Salesforce:    ' + $r.totalSalesforce);" ^
  "Write-Host ('Leads en sesion:        ' + $r.totalSesion);" ^
  "Write-Host ('Coinciden:              ' + $r.coinciden + ' (' + $r.porcentajeCobertura + '%%)');" ^
  "Write-Host ('Faltan en sesion:       ' + $r.faltantesEnSesion);" ^
  "Write-Host ('  creados despues:      ' + $r.creadosDespuesDeLaCarga);" ^
  "Write-Host ('  modificados despues:  ' + $r.modificadosDespuesDeLaCarga);" ^
  "Write-Host ('  ANOMALIAS:            ' + $r.anomalias);" ^
  "Write-Host ('Sobran en sesion:       ' + $r.sobrantesEnSesion);" ^
  "Write-Host ('Registrados acumulados: ' + $r.registradosAcumulados);" ^
  "if ($r.alcance.desdeAjustadoALaSesion) { Write-Host ''; Write-Host 'Aviso: la fecha se ajusto al inicio de la sesion cargada.' }" ^
  "if ($r.estado -eq 'SESION_DESACTUALIZADA') { Write-Host ''; Write-Host 'Las diferencias son esperables: se resuelven con /cargar.' }"

set "RC=%errorlevel%"
echo.
echo Respuesta completa guardada en %SALIDA%
echo.
pause
exit /b %RC%
