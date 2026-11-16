@echo off
setlocal EnableExtensions
chcp 65001 >nul

rem ============================================================
rem informe-diario.bat - disparar y enviar informe de conciliación
rem ============================================================
rem Llama a POST /informe-diario/enviar, envía el reporte por mail
rem a los destinatarios configurados en MAIL_TO y muestra el resultado.
rem
rem Uso:
rem   informe-diario.bat                genera informe desde 2026-01-01
rem   informe-diario.bat 2026-03-01     genera informe desde esa fecha
rem
rem El token NO se guarda en este archivo. Se toma de la variable
rem de entorno MCP_TOKEN o se pide al ejecutar. Para no tipearlo
rem cada vez:  setx MCP_TOKEN "tu_token"  (y abrir otra consola).
rem Para probar en local: set "API_URL=http://localhost:3000"
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

for /f %%t in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"') do set "STAMP=%%t"
set "SALIDA=informe-%STAMP%.json"

echo.
echo Disparando informe en %API_URL%/informe-diario/enviar desde %DESDE% ...
echo (si el servicio estaba dormido o tiene que cargar Salesforce puede tardar ~1 minuto)
echo.

curl -sS --max-time 300 -X POST ^
  -H "Authorization: Bearer %MCP_TOKEN%" ^
  -H "Accept: application/json" ^
  -o "%SALIDA%" -w "HTTP %%{http_code}\n" ^
  "%API_URL%/informe-diario/enviar?desde=%DESDE%"

if errorlevel 1 (
  echo No se pudo conectar con el servidor.
  exit /b 1
)

powershell -NoProfile -Command ^
  "$t = ''; if (Test-Path '%SALIDA%') { $t = [string](Get-Content -Raw -Encoding UTF8 -ErrorAction SilentlyContinue '%SALIDA%') };" ^
  "if ([string]::IsNullOrWhiteSpace($t)) { Write-Host 'Respuesta vacia: token incorrecto o ruta inexistente (el servidor responde 404 sin cuerpo).'; exit 3 }" ^
  "if ($t -match 'Just a moment') { Write-Host 'Cloudflare bloqueo el pedido (pagina de desafio). Proba de nuevo en unos minutos o desde otra red.'; exit 2 }" ^
  "try { $r = $t | ConvertFrom-Json } catch { Write-Host 'La respuesta no es JSON:'; Write-Host $t.Substring(0, [Math]::Min(500, $t.Length)); exit 4 }" ^
  "if (-not $r.ok) { Write-Host ('Error: ' + $r.error); if ($r.error -match 'variables de entorno') { Write-Host 'Verifica que RESEND_API_KEY, MAIL_FROM y MAIL_TO esten definidas en el servidor.' } elseif ($r.error -match 'Salesforce') { Write-Host 'Fallo la carga de Salesforce. Revisa credenciales SF en el servidor.' }; exit 5 }" ^
  "Write-Host '';" ^
  "Write-Host '==========================================';" ^
  "Write-Host 'INFORME ENVIADO CON EXITO';" ^
  "Write-Host '==========================================';" ^
  "Write-Host ('ID del mail (Resend):   ' + $r.idMail);" ^
  "Write-Host ('Estado del informe:     ' + $r.estado);" ^
  "Write-Host ('Destinatarios:          ' + $r.destinatarios);" ^
  "if ($r.archivoAdjunto) { Write-Host ('Archivo adjunto:        ' + $r.archivoAdjunto) };" ^
  "Write-Host ('Faltan en el sistema:   ' + $r.faltanEnSistema);" ^
  "Write-Host ('Faltan en Salesforce:   ' + $r.faltanEnSalesforce);" ^
  "Write-Host ('Anomalias (sin explic): ' + $r.sinExplicacion);" ^
  "if ($r.recienCargada) { Write-Host ''; Write-Host 'Nota: La sesion estaba vacia y se cargo Salesforce antes de enviar.' }"

set "RC=%errorlevel%"
echo.
echo Respuesta completa guardada en %SALIDA%
echo.
pause
exit /b %RC%
