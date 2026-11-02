@echo off
setlocal EnableExtensions

rem ============================================================
rem conciliacion.bat - leads de Salesforce vs. leads en sesion
rem ============================================================
rem Uso (doble clic o desde una consola):
rem   conciliacion.bat                      compara desde 2026-01-01
rem   conciliacion.bat 2026-03-01           compara desde esa fecha
rem   conciliacion.bat 2026-03-01 resumen   sin el detalle de faltantes
rem
rem Pasos que hace:
rem   1. Consulta /estado (despierta el servicio y valida el token).
rem   2. Si hay una carga en curso, espera a que termine.
rem   3. Si no hay sesion cargada, ofrece hacer /cargar.
rem   4. Llama a /conciliacion, muestra el resumen y guarda la
rem      respuesta completa en conciliacion-AAAAMMDD-HHMMSS.json.
rem ============================================================

rem ---- TOKEN -------------------------------------------------
rem Pegalo entre el = y las comillas finales, por ejemplo:
rem   set "TOKEN=abc123..."
rem Si lo dejas vacio, se usa la variable MCP_TOKEN o se pide.
set "TOKEN="

set "API_URL=https://mcpfunnel.onrender.com"
set "DESDE=%~1"
set "MODO=%~2"
set "CARPETA=%~dp0"

rem El codigo PowerShell esta al final de este mismo archivo.
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Get-Content -LiteralPath '%~f0' -Raw; $i = $s.IndexOf('#' + 'PS' + '#'); Invoke-Expression $s.Substring($i)"

echo.
pause
exit /b

#PS#
function Main {
  $ErrorActionPreference = 'Stop'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  $base = $env:API_URL.TrimEnd('/')

  $token = $env:TOKEN
  if (-not $token) { $token = $env:MCP_TOKEN }
  if (-not $token) { $token = Read-Host 'Token (MCP_TOKEN)' }
  $token = ([string]$token).Trim().Trim('"').Trim()
  if (-not $token) { Write-Host 'Falta el token.' -ForegroundColor Red; return }

  $desde = if ($env:DESDE) { $env:DESDE } else { '2026-01-01' }
  if ($desde -notmatch '^\d{4}-\d{2}-\d{2}$') {
    Write-Host "Fecha invalida: '$desde'. Formato AAAA-MM-DD, por ejemplo 2026-01-01." -ForegroundColor Red
    return
  }
  $detalle = if ($env:MODO -eq 'resumen') { 'false' } else { 'true' }

  $headers = @{ Authorization = "Bearer $token"; Accept = 'application/json' }

  function Pedir([string]$metodo, [string]$ruta, [int]$timeout) {
    $code = 0
    $body = ''
    try {
      $p = @{ Uri = "$base$ruta"; Method = $metodo; Headers = $headers; TimeoutSec = $timeout; UseBasicParsing = $true }
      if ($metodo -eq 'POST') { $p.Body = '{}'; $p.ContentType = 'application/json' }
      $r = Invoke-WebRequest @p
      $code = [int]$r.StatusCode
      $body = [string]$r.Content
    } catch [System.Net.WebException] {
      $resp = $_.Exception.Response
      if (-not $resp) { throw "No se pudo conectar con $base ($($_.Exception.Message))" }
      $code = [int]$resp.StatusCode
      $body = (New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
    }

    if ($body -match 'Just a moment') {
      throw 'Cloudflare bloqueo el pedido (pagina de desafio). Proba de nuevo en unos minutos o desde otra red.'
    }
    if ($code -eq 404 -and -not $body.Trim()) {
      throw 'Token incorrecto: el servidor respondio 404 sin contenido.'
    }
    try { $json = $body | ConvertFrom-Json } catch {
      $corto = $body.Substring(0, [Math]::Min(300, $body.Length))
      throw "Respuesta no JSON (HTTP $code): $corto"
    }
    return @{ code = $code; body = $body; json = $json }
  }

  # 1. Estado (despierta el servicio y valida el token)
  Write-Host "Conectando con $base ..."
  Write-Host '(si el servicio estaba dormido puede tardar ~1 minuto)'
  $estado = (Pedir 'GET' '/estado' 180).json

  function EsperarCarga($estado) {
    $esperado = 0
    while ($estado.cargaEnProceso) {
      if ($esperado -ge 1800) { throw 'La carga lleva mas de 30 minutos. Revisa los logs de Render.' }
      Write-Host "Carga de Salesforce en curso; esperando... ($([int]($esperado / 60)) min)"
      Start-Sleep -Seconds 15
      $esperado += 15
      $estado = (Pedir 'GET' '/estado' 60).json
    }
    return $estado
  }

  # 2. Carga en curso: esperar
  $estado = EsperarCarga $estado

  # 3. Sin sesion: ofrecer /cargar
  if (-not $estado.sesionCargada) {
    Write-Host ''
    Write-Host 'No hay datos cargados en el servidor.' -ForegroundColor Yellow
    $resp = Read-Host 'Cargar ahora desde Salesforce? Tarda varios minutos (s/n)'
    if ($resp -notmatch '^[sS]') { Write-Host 'Cancelado. Sin sesion cargada no se puede comparar.'; return }
    Write-Host 'Cargando... (no cierres esta ventana)'
    try {
      $carga = (Pedir 'POST' '/cargar' 1800).json
      if (-not $carga.ok) { throw "Fallo /cargar: $($carga.error)" }
    } catch {
      if ($_.Exception.Message -match 'Token|Fallo /cargar') { throw }
      # La conexion se corto (timeout del proxy), pero la carga
      # sigue en el servidor: se espera consultando /estado.
      Write-Host 'La conexion se corto; la carga sigue en el servidor.' -ForegroundColor Yellow
      $estado = EsperarCarga ((Pedir 'GET' '/estado' 60).json)
      if (-not $estado.sesionCargada) { throw 'La carga termino sin datos. Revisa los logs de Render.' }
    }
    Write-Host 'Carga terminada.' -ForegroundColor Green
  } else {
    Write-Host "Sesion cargada: $($estado.totalLeads) leads, ultima carga $($estado.ultimaCarga)"
  }

  # 4. Conciliacion
  Write-Host ''
  Write-Host "Comparando contra Salesforce desde $desde ..."
  $res = Pedir 'GET' "/conciliacion?desde=$desde&incluirDetalle=$detalle" 600
  $r = $res.json

  $archivo = Join-Path $env:CARPETA ('conciliacion-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
  [System.IO.File]::WriteAllText($archivo, $res.body, (New-Object System.Text.UTF8Encoding($false)))

  if (-not $r.ok) { throw "Error del servidor: $($r.error)" }

  $color = switch ($r.estado) {
    'SIN_DIFERENCIAS' { 'Green' }
    'SESION_DESACTUALIZADA' { 'Yellow' }
    default { 'Red' }
  }

  Write-Host ''
  Write-Host ('Estado:                 ' + $r.estado) -ForegroundColor $color
  Write-Host ('Desde:                  ' + $r.alcance.desde)
  Write-Host ('Sesion cargada en:      ' + $r.cargadoEn)
  Write-Host ('Leads en Salesforce:    ' + $r.totalSalesforce)
  Write-Host ('Leads en sesion:        ' + $r.totalSesion)
  Write-Host ('Coinciden:              ' + $r.coinciden + ' (' + $r.porcentajeCobertura + ' %)')
  Write-Host ('Faltan en sesion:       ' + $r.faltantesEnSesion)
  Write-Host ('  creados despues:      ' + $r.creadosDespuesDeLaCarga)
  Write-Host ('  modificados despues:  ' + $r.modificadosDespuesDeLaCarga)
  Write-Host ('  ANOMALIAS:            ' + $r.anomalias)
  Write-Host ('Sobran en sesion:       ' + $r.sobrantesEnSesion)
  Write-Host ('Registrados acumulados: ' + $r.registradosAcumulados)

  if ($r.alcance.desdeAjustadoALaSesion) {
    Write-Host ''
    Write-Host 'Aviso: la fecha se ajusto al inicio de la sesion cargada.' -ForegroundColor Yellow
  }

  $anomalas = @($r.faltantes | Where-Object { $_.motivo -eq 'creado_antes_y_no_esta' })
  if ($anomalas.Count -gt 0) {
    Write-Host ''
    Write-Host 'Anomalias (primeras 20):' -ForegroundColor Red
    $anomalas | Select-Object -First 20 idSalesforce, nombre, creadoEn | Format-Table -AutoSize | Out-String | Write-Host
  } elseif ($r.estado -eq 'SESION_DESACTUALIZADA') {
    Write-Host ''
    Write-Host 'Las diferencias son esperables: se resuelven con una nueva carga (/cargar).'
  }

  Write-Host ''
  Write-Host "Respuesta completa guardada en $archivo"
}

try { Main } catch { Write-Host ''; Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red }
